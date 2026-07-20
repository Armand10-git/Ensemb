import * as fs from 'fs';
import * as path from 'path';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import ExcelJS from 'exceljs';
import { PrismaService } from '../common/prisma.service';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';
import type { ExcelExportJobData } from '../modules/partners/partners.service';

/**
 * Worker BullMQ dédié à la génération des exports Excel partenaires (S12 — §17 point Z).
 * Tourne dans le process worker dédié (WorkerModule) — jamais dans le process HTTP.
 *
 * Job géré : partners.export
 *   - Requête tous les clients ou fournisseurs de l'org
 *   - Génère un fichier .xlsx avec exceljs (en-têtes gras, colonnes auto-width)
 *   - Stocke sous storage/exports/<organizationId>/<orgId>-<type>-<timestamp>.xlsx
 *   - Émet Socket.io export:completed ou export:failed vers org:<organizationId>
 */
@Processor('excel')
export class ExcelWorker extends WorkerHost {
  private readonly logger = new Logger(ExcelWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<ExcelExportJobData>): Promise<void> {
    const { organizationId, type } = job.data;

    if (!organizationId || !type) {
      this.logger.error(`Job excel sans organizationId ou type — ignoré`);
      return;
    }

    if (job.name === 'partners.export') {
      await this.handlePartnersExport(job.data);
    } else {
      this.logger.warn(`Job excel inconnu : ${job.name}`);
    }
  }

  private async handlePartnersExport(data: ExcelExportJobData): Promise<void> {
    const { organizationId, type } = data;

    try {
      const rows = type === 'clients'
        ? await this.prisma.client.findMany({
            where: { organizationId, deletedAt: null },
            select: {
              code: true, name: true, email: true,
              phone: true, country: true, city: true, address: true,
            },
            orderBy: { code: 'asc' },
          })
        : await this.prisma.provider.findMany({
            where: { organizationId, deletedAt: null },
            select: {
              code: true, name: true, email: true,
              phone: true, country: true, city: true, address: true,
            },
            orderBy: { code: 'asc' },
          });

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Ensemb ERP';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet(type === 'clients' ? 'Clients' : 'Fournisseurs');

      const COLUMNS: { header: string; key: string; width: number }[] = [
        { header: 'Code',     key: 'code',    width: 10 },
        { header: 'Nom',      key: 'name',    width: 35 },
        { header: 'Email',    key: 'email',   width: 30 },
        { header: 'Téléphone', key: 'phone',  width: 18 },
        { header: 'Pays',     key: 'country', width: 20 },
        { header: 'Ville',    key: 'city',    width: 20 },
        { header: 'Adresse',  key: 'address', width: 40 },
      ];

      sheet.columns = COLUMNS;

      // En-têtes gras
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.commit();

      for (const row of rows) {
        sheet.addRow(row);
      }

      const timestamp = Date.now();
      const filename  = `${organizationId}-${type}-${timestamp}.xlsx`;
      const dir       = path.join(process.cwd(), 'storage', 'exports', organizationId);
      const filePath  = path.join(dir, filename);

      // TODO S13-debt: migrer vers S3-compatible (§17 point Y)
      fs.mkdirSync(dir, { recursive: true });
      await workbook.xlsx.writeFile(filePath);

      const downloadUrl = `/api/v1/partners/${type}/export/download/${filename}`;

      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('export:completed', { type, filename, downloadUrl });

      this.logger.log(`Export Excel ${type} org ${organizationId} → ${filename}`);
    } catch (err) {
      this.logger.error(`Erreur export Excel ${type} org ${organizationId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('export:failed', { type, message: 'La génération du fichier Excel a échoué.' });
    }
  }
}
