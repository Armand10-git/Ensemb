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

      // TODO T09-debt: migrer vers S3-compatible (S13, §17 point Y)
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      let content: string;
      if (format === 'CSV') {
        content = this.serializeToCSV(users, roles, roleAssignments);
      } else {
        content = JSON.stringify(exportData, null, 2);
      }

      const sizeBytes = Buffer.byteLength(content, 'utf-8');
      fs.writeFileSync(filePath, content, 'utf-8');

      await this.prisma.backupExport.update({
        where: { id: exportId },
        data: { status: 'COMPLETED', filename, sizeBytes, completedAt: new Date() },
      });

      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('backup:completed', { exportId, filename, size: sizeBytes });

      this.logger.log(`Export ${exportId} complété pour org ${organizationId} (${sizeBytes} octets)`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Erreur génération export ${exportId} pour org ${organizationId}`, err);

      await this.prisma.backupExport.update({
        where: { id: exportId },
        data: { status: 'FAILED', errorMessage },
      });
      // Ne pas relancer : FAILED est définitif, l'utilisateur peut redemander un export
    }
  }

  private async handlePurge(data: BackupJobData): Promise<void> {
    const { organizationId } = data;

    try {
      await this.backupService.purgeOldExports(organizationId);
    } catch (err) {
      this.logger.error(`Erreur purge exports pour org ${organizationId}`, err);
      throw err;
    }
  }

  /** Sérialise les trois entités en sections CSV séparées. Chaque section a sa propre ligne d'en-tête. */
  private serializeToCSV(
    users: object[],
    roles: object[],
    roleAssignments: object[],
  ): string {
    const section = (label: string, rows: object[]): string => {
      const first = rows[0];
      const csv =
        first !== undefined
          ? stringify(rows, { header: true, columns: Object.keys(first) })
          : `${label}: (vide)\n`;
      return `# ${label}\n${csv}`;
    };

    return [
      section('users', users),
      section('roles', roles),
      section('roleAssignments', roleAssignments),
    ].join('\n');
  }
}
