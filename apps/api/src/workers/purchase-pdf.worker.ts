import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PurchaseService } from '../modules/purchases/purchase.service';
import { PdfService } from '../modules/pdf/pdf.service';
import { StorageService } from '../modules/uploads/storage.service';
import { PrismaService } from '../common/prisma.service';
import { renderPurchasePdfContent } from '../modules/pdf/purchase-pdf.template';
import { wrapBrandedPdf, PdfOrganizationBranding } from '../modules/pdf/branded-pdf.template';
import { PdfJobData, pdfJobName } from '../modules/pdf/pdf-job.types';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';

/**
 * Contrat du job de la file `pdf` pour la génération d'un bon d'achat (S34).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker —
 * mirror exact du patron déjà utilisé pour la file `email` (cf. purchase-email.worker.ts).
 *
 *   queue : 'pdf'
 *   job.name : 'purchase.generatePdf' (pdfJobName('purchase'))
 *   job.data : PdfJobData avec documentType: 'purchase', documentId = Purchase.id
 *
 * `requestedBy` (PdfJobData) n'est utilisé qu'à des fins de traçabilité/journalisation — aucun
 * contrôle d'accès ne s'appuie dessus, l'anti-IDOR est déjà couvert par
 * PurchaseService.findOne(documentId, organizationId) ci-dessous.
 */
@Processor('pdf')
export class PurchasePdfWorker extends WorkerHost {
  private readonly logger = new Logger(PurchasePdfWorker.name);

  constructor(
    private readonly purchaseService: PurchaseService,
    private readonly pdfService: PdfService,
    private readonly storageService: StorageService,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<PdfJobData>): Promise<void> {
    if (job.name !== pdfJobName('purchase')) {
      this.logger.warn(`Job inconnu sur la file pdf : ${job.name}`);
      return;
    }

    const { organizationId, documentId } = job.data;
    if (!organizationId || !documentId) {
      this.logger.error('purchase.generatePdf sans organizationId ou documentId — job ignoré');
      return;
    }

    try {
      const purchase = await this.purchaseService.findOne(documentId, organizationId);
      const [productNames, branding] = await Promise.all([
        this.loadProductNames(
          organizationId,
          (purchase.details ?? []).map((d) => d.productId),
        ),
        this.loadBranding(organizationId),
      ]);

      const content = renderPurchasePdfContent({
        reference: purchase.reference,
        date: purchase.date,
        status: purchase.status,
        paymentStatus: purchase.paymentStatus,
        providerName: purchase.provider?.name ?? null,
        warehouseName: purchase.warehouse?.name ?? null,
        discount: purchase.discount,
        taxAmount: purchase.taxAmount,
        shipping: purchase.shipping,
        grandTotal: purchase.grandTotal,
        details: (purchase.details ?? []).map((d) => ({
          productId: d.productId,
          productName: productNames.get(d.productId) ?? null,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      const html = wrapBrandedPdf(`Bon d'achat ${purchase.reference}`, content, branding);
      const buffer = await this.pdfService.render(html);

      // Clé déterministe — écrase toute version précédente, pas d'accumulation d'objets S3
      // pour un même document (cf. session prompt S34).
      const key = `${organizationId}/pdf/purchase/${documentId}.pdf`;
      await this.storageService.upload(key, buffer, 'application/pdf');
      const url = await this.storageService.getSignedUrl(key);

      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('pdf:ready', { documentType: 'purchase', documentId, url });

      this.logger.log(`PDF de l'achat ${documentId} généré et uploadé (${key})`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Achat introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un achat
        // qui n'existe plus.
        this.logger.warn(
          `purchase.generatePdf : achat ${documentId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      this.logger.error(`purchase.generatePdf : échec pour l'achat ${documentId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('pdf:generateFailed', { documentType: 'purchase', documentId });
      // Erreur inattendue (ex. échec Puppeteer/S3 transitoire) : on relance pour que BullMQ
      // retente (backoff configuré dans PdfQueueModule).
      throw err;
    }
  }

  /**
   * Charge les noms des produits référencés par un achat — PurchaseService.findOne ne renvoie
   * que productId ; le nom est chargé séparément ici via PrismaService (lecture ponctuelle,
   * pas de ProductService dédié importé pour ça). Mirror exact de purchase-email.worker.ts.
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
   * ponctuelle via PrismaService, mirror de loadBranding dans purchase-email.worker.ts avec
   * `name` en plus (affiché dans l'en-tête du document imprimé, cf. PdfOrganizationBranding).
   */
  private async loadBranding(organizationId: string): Promise<PdfOrganizationBranding> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, logoUrl: true, primaryColor: true },
    });
    return {
      name: org?.name ?? 'Organisation',
      logoUrl: org?.logoUrl ?? null,
      primaryColor: org?.primaryColor ?? null,
    };
  }
}
