import * as fs from 'fs';
import * as path from 'path';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma.service';
import type { PaginatedResult } from '../../common/types';
import type { BackupExport, ExportFormat } from '@prisma/client';

export type { PaginatedResult };

export interface BackupJobData {
  exportId: string;
  organizationId: string;
  format: ExportFormat;
}

export interface BackupExportSummary {
  id: string;
  status: BackupExport['status'];
  format: BackupExport['format'];
  filename: string | null;
  sizeBytes: number | null;
  requestedAt: Date;
  completedAt: Date | null;
}

/**
 * Service de gestion des exports de données par organisation (T09 — §17 point N).
 *
 * Invariants de sécurité :
 *  - organizationId est toujours extrait de req.user, jamais de l'URL (anti-IDOR).
 *  - Chaque requête Prisma filtre explicitement sur organizationId.
 *  - errorMessage n'est jamais inclus dans les réponses HTTP (log serveur uniquement).
 *  - Le chemin absolu du fichier n'est jamais exposé côté client.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('backup') private readonly backupQueue: Queue<BackupJobData>,
  ) {}

  async requestExport(
    organizationId: string,
    format: ExportFormat,
  ): Promise<{ exportId: string }> {
    const backupExport = await this.prisma.backupExport.create({
      data: { organizationId, format, status: 'PENDING' },
    });

    await this.backupQueue.add('export.generate', {
      exportId: backupExport.id,
      organizationId,
      format,
    });

    this.logger.log(`Export ${backupExport.id} demandé pour org ${organizationId} (${format})`);
    return { exportId: backupExport.id };
  }

  async listExports(
    organizationId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<BackupExportSummary>> {
    const skip = (page - 1) * limit;

    const [total, exports] = await Promise.all([
      this.prisma.backupExport.count({ where: { organizationId } }),
      this.prisma.backupExport.findMany({
        where: { organizationId },
        orderBy: { requestedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          status: true,
          format: true,
          filename: true,
          sizeBytes: true,
          requestedAt: true,
          completedAt: true,
          // errorMessage intentionnellement exclu — log serveur uniquement
        },
      }),
    ]);

    return { data: exports, total, page, limit };
  }

  async getDownloadStream(
    exportId: string,
    organizationId: string,
  ): Promise<{ stream: fs.ReadStream; filename: string; mimeType: string }> {
    const backupExport = await this.assertOwnership(exportId, organizationId);

    if (backupExport.status !== 'COMPLETED') {
      throw new BadRequestException("Cet export n'est pas encore disponible.");
    }

    if (!backupExport.filename) {
      throw new BadRequestException("Fichier export manquant.");
    }

    const filePath = this.buildFilePath(organizationId, exportId, backupExport.format);

    if (!fs.existsSync(filePath)) {
      throw new BadRequestException("Fichier export introuvable sur le serveur.");
    }

    const mimeType = backupExport.format === 'CSV' ? 'text/csv' : 'application/json';

    return {
      stream: fs.createReadStream(filePath),
      filename: backupExport.filename,
      mimeType,
    };
  }

  async deleteExport(exportId: string, organizationId: string): Promise<void> {
    const backupExport = await this.assertOwnership(exportId, organizationId);

    // Suppression fichier physique d'abord — si échec, pas de suppression BDD (cohérence)
    if (backupExport.filename) {
      const filePath = this.buildFilePath(organizationId, exportId, backupExport.format);
      try {
        fs.unlinkSync(filePath);
        this.logger.log(`Fichier supprimé : ${filePath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    await this.prisma.backupExport.delete({ where: { id: exportId } });
    this.logger.log(`BackupExport ${exportId} supprimé pour org ${organizationId}`);
  }

  async purgeOldExports(organizationId: string, retentionDays = 30): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const oldExports = await this.prisma.backupExport.findMany({
      where: {
        organizationId,
        status: { in: ['COMPLETED', 'FAILED'] },
        requestedAt: { lt: cutoff },
      },
    });

    await Promise.all(
      oldExports
        .filter((exp) => exp.filename !== null)
        .map(async (exp) => {
          const filePath = this.buildFilePath(organizationId, exp.id, exp.format);
          try {
            fs.unlinkSync(filePath);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        }),
    );

    const ids = oldExports.map((e) => e.id);
    if (ids.length > 0) {
      await this.prisma.backupExport.deleteMany({ where: { id: { in: ids } } });
      this.logger.log(
        `Purge : ${ids.length} export(s) supprimé(s) pour org ${organizationId} (rétention ${retentionDays}j)`,
      );
    }
  }

  /**
   * Construit le chemin absolu du fichier export.
   * @internal Exposé pour BackupWorker uniquement — TODO T09-debt: migrer vers S3-compatible (S13, §17 point Y).
   */
  buildFilePath(organizationId: string, exportId: string, format: ExportFormat): string {
    const ext = format === 'CSV' ? 'csv' : 'json';
    return path.join(process.cwd(), 'storage', 'exports', organizationId, `${exportId}.${ext}`);
  }

  /** Vérifie l'existence et l'ownership d'un export — lève 404 ou 403 selon le cas. */
  private async assertOwnership(exportId: string, organizationId: string): Promise<BackupExport> {
    const backupExport = await this.prisma.backupExport.findUnique({ where: { id: exportId } });

    if (!backupExport) throw new NotFoundException('Export introuvable.');
    if (backupExport.organizationId !== organizationId)
      throw new ForbiddenException('Accès non autorisé à cet export.');

    return backupExport;
  }
}
