import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'csv-stringify/sync';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../common/prisma.service';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';
import { BackupService, type BackupJobData } from '../modules/backup/backup.service';

/**
 * Worker BullMQ dédié aux exports de données par organisation (T09 — §17 point N).
 * Tourne dans le même process worker que BillingWorker (§17 point Z).
 *
 * Jobs gérés :
 *   - export.generate : génère le fichier CSV/JSON scopé à un tenant.
 *   - export.purge    : purge les exports expirés pour chaque organisation active.
 *
 * Invariant : chaque job transporte son organizationId — jamais de requête cross-tenant.
 */
@Processor('backup')
export class BackupWorker extends WorkerHost {
  private readonly logger = new Logger(BackupWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backupService: BackupService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<BackupJobData>): Promise<void> {
    const { organizationId } = job.data;

    if (!organizationId) {
      this.logger.error(`Job ${job.name} sans organizationId — ignoré`);
      return;
    }

    switch (job.name) {
      case 'export.generate':
        await this.handleGenerate(job.data);
        break;
      case 'export.purge':
        await this.handlePurge(job.data);
        break;
      default:
        this.logger.warn(`Job backup inconnu : ${job.name}`);
    }
  }

  /**
   * Génère le fichier CSV ou JSON pour un export donné.
   * Passe le statut PENDING → PROCESSING → COMPLETED (ou FAILED).
   * Émet backup:completed via Socket.io vers la room de l'organisation.
   */
  private async handleGenerate(data: BackupJobData): Promise<void> {
    const { exportId, organizationId, format } = data;

    await this.prisma.backupExport.update({
      where: { id: exportId },
      data: { status: 'PROCESSING' },
    });

    try {
      // TODO T09-debt: ajouter les tables métier (Sales, Products, Customers…) quand les modules seront créés
      const [users, roles, roleAssignments] = await Promise.all([
        this.prisma.user.findMany({
          where: { organizationId },
          select: {
            id: true,
            firstname: true,
            lastname: true,
            email: true,
            username: true,
            isActive: true,
            createdAt: true,
          },
        }),
        this.prisma.role.findMany({
          where: { organizationId },
          select: { id: true, name: true, label: true, status: true },
        }),
        this.prisma.roleOnUser.findMany({
          where: { user: { organizationId } },
          select: { userId: true, roleId: true },
        }),
      ]);

      const exportData = { users, roles, roleAssignments };
      const ext = format === 'CSV' ? 'csv' : 'json';
      const filename = `export-${exportId}.${ext}`;
      const filePath = this.backupService.buildFilePath(organizationId, exportId, format);

      // Crée le répertoire si nécessaire — TODO T09-debt: migrer vers S3-compatible (S13, §17 point Y)
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let content: string;
      if (format === 'CSV') {
        // Sérialiser chaque entité séparément avec header — sections séparées par une ligne vide
        const firstUser = users[0];
        const firstRole = roles[0];
        const firstAssignment = roleAssignments[0];

        const usersSection =
          firstUser !== undefined
            ? stringify(users, { header: true, columns: Object.keys(firstUser) })
            : 'users: (vide)\n';
        const rolesSection =
          firstRole !== undefined
            ? stringify(roles, { header: true, columns: Object.keys(firstRole) })
            : 'roles: (vide)\n';
        const roleAssignmentsSection =
          firstAssignment !== undefined
            ? stringify(roleAssignments, {
                header: true,
                columns: Object.keys(firstAssignment),
              })
            : 'roleAssignments: (vide)\n';

        content = [
          '# users',
          usersSection,
          '# roles',
          rolesSection,
          '# roleAssignments',
          roleAssignmentsSection,
        ].join('\n');
      } else {
        content = JSON.stringify(exportData, null, 2);
      }

      fs.writeFileSync(filePath, content, 'utf-8');
      const stats = fs.statSync(filePath);

      await this.prisma.backupExport.update({
        where: { id: exportId },
        data: {
          status: 'COMPLETED',
          filename,
          sizeBytes: stats.size,
          completedAt: new Date(),
        },
      });

      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('backup:completed', { exportId, filename, size: stats.size });

      this.logger.log(`Export ${exportId} complété pour org ${organizationId} (${stats.size} octets)`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Erreur génération export ${exportId} pour org ${organizationId}`, err);

      await this.prisma.backupExport.update({
        where: { id: exportId },
        data: { status: 'FAILED', errorMessage },
      });
      // Ne pas relancer : le statut FAILED est définitif, l'utilisateur peut redemander un export
    }
  }

  /**
   * Purge les exports expirés pour toutes les organisations actives.
   * Planifié quotidiennement par BullMQ repeat.
   */
  private async handlePurge(data: BackupJobData): Promise<void> {
    const { organizationId } = data;

    try {
      await this.backupService.purgeOldExports(organizationId);
    } catch (err) {
      this.logger.error(`Erreur purge exports pour org ${organizationId}`, err);
      throw err;
    }
  }
}
