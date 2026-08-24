import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QuotationService } from '../modules/quotations/quotation.service';
import { PdfService } from '../modules/pdf/pdf.service';
import { StorageService } from '../modules/uploads/storage.service';
import { PrismaService } from '../common/prisma.service';
import { renderQuotationPdfContent } from '../modules/pdf/quotation-pdf.template';
import { wrapBrandedPdf, type PdfOrganizationBranding } from '../modules/pdf/branded-pdf.template';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';
import { pdfJobName, type PdfJobData } from '../modules/pdf/pdf-job.types';

/**
 * Worker BullMQ dédié à la génération PDF brandée d'un devis (S34).
 * Tourne dans le process worker dédié (§17 point Z), jamais dans le process HTTP — Puppeteer
 * (PdfService) est trop coûteux en CPU/mémoire pour cohabiter avec le cycle requête/réponse.
 *
 * Recharge le devis via QuotationService.findOne (anti-IDOR déjà géré — organizationId vérifié),
 * charge les noms de produits séparément (QuotationService.findOne ne renvoie que productId, cf.
 * JSDoc de QuotationPdfLine dans quotation-pdf.template.ts) ainsi que le branding de
 * l'organisation, rend le contenu via renderQuotationPdfContent, l'habille avec wrapBrandedPdf,
 * le convertit en PDF via PdfService.render, puis l'upload sur S3 (StorageService) avant
 * d'émettre l'URL signée en temps réel. Mirror structurel exact de quotation-email.worker.ts,
 * sans paymentStatus (un devis n'est jamais payé).
 */
@Processor('pdf')
export class QuotationPdfWorker extends WorkerHost {
  private readonly logger = new Logger(QuotationPdfWorker.name);

  constructor(
    private readonly quotationService: QuotationService,
    private readonly pdfService: PdfService,
    private readonly storageService: StorageService,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<PdfJobData>): Promise<void> {
    if (job.name !== pdfJobName('quotation')) {
      this.logger.warn(`Job inconnu sur la file pdf : ${job.name}`);
      return;
    }

    const { organizationId, documentId } = job.data;
    if (!organizationId || !documentId) {
      this.logger.error('quotation.generatePdf sans organizationId ou documentId — job ignoré');
      return;
    }

    try {
      const quotation = await this.quotationService.findOne(documentId, organizationId);
      const [productNames, branding] = await Promise.all([
        this.loadProductNames(
          organizationId,
          (quotation.details ?? []).map((d) => d.productId),
        ),
        this.loadBranding(organizationId),
      ]);

      const content = renderQuotationPdfContent({
        reference: quotation.reference,
        date: quotation.date,
        status: quotation.status,
        clientName: quotation.client?.name ?? null,
        warehouseName: quotation.warehouse?.name ?? null,
        discount: quotation.discount,
        taxAmount: quotation.taxAmount,
        shipping: quotation.shipping,
        grandTotal: quotation.grandTotal,
        details: (quotation.details ?? []).map((d) => ({
          productId: d.productId,
          productName: productNames.get(d.productId) ?? null,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      const html = wrapBrandedPdf(`Devis ${quotation.reference}`, content, branding);
      const buffer = await this.pdfService.render(html);

      const key = `${organizationId}/pdf/quotation/${documentId}.pdf`;
      await this.storageService.upload(key, buffer, 'application/pdf');
      const url = await this.storageService.getSignedUrl(key);

      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('pdf:ready', { documentType: 'quotation', documentId, url });

      this.logger.log(`PDF du devis ${documentId} généré et disponible sur ${key}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Devis introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un devis
        // qui n'existe plus.
        this.logger.warn(
          `quotation.generatePdf : devis ${documentId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      this.logger.error(`quotation.generatePdf : échec pour le devis ${documentId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('pdf:generateFailed', { documentType: 'quotation', documentId });
      // Erreur inattendue (ex. échec Puppeteer transitoire) : on relance pour que BullMQ
      // retente (defaultJobOptions.attempts, backoff exponentiel — cf. PdfQueueModule).
      throw err;
    }
  }

  /**
   * Charge les noms des produits référencés par un devis — QuotationService.findOne ne renvoie
   * que productId ; le nom est chargé séparément ici via PrismaService (lecture ponctuelle,
   * mirror exact de quotation-email.worker.ts).
   */
  private async loadProductNames(
    organizationId: string,
    productIds: string[],
  ): Promise<Map<string, string>> {
    if (productIds.length === 0) return new Map();
    const products = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(productIds)] }, organizationId },
      select: { id: true, name: true },
    });
    return new Map(products.map((p) => [p.id, p.name]));
  }

  /**
   * Charge le nom/logo/couleur de l'organisation pour l'habillage brandé du PDF (S34) — lecture
   * ponctuelle via PrismaService, mirror de loadBranding dans quotation-email.worker.ts, avec
   * `name` en plus (affiché dans l'en-tête du document imprimé, absent de l'habillage email).
   */
  private async loadBranding(organizationId: string): Promise<PdfOrganizationBranding> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, logoUrl: true, primaryColor: true },
    });
    return {
      name: org?.name ?? '',
      logoUrl: org?.logoUrl ?? null,
      primaryColor: org?.primaryColor ?? null,
    };
  }
}
