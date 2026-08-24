import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SaleService } from '../modules/sales/sale.service';
import { PdfService } from '../modules/pdf/pdf.service';
import { StorageService } from '../modules/uploads/storage.service';
import { PrismaService } from '../common/prisma.service';
import { renderSalePdfContent } from '../modules/pdf/sale-pdf.template';
import { wrapBrandedPdf, PdfOrganizationBranding } from '../modules/pdf/branded-pdf.template';
import { PdfJobData, pdfJobName } from '../modules/pdf/pdf-job.types';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';

/**
 * Contrat du job de la file `pdf` pour la génération d'une facture de vente (S34).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker —
 * mirror exact du patron déjà utilisé pour la file `email` (cf. sale-email.worker.ts).
 *
 *   queue : 'pdf'
 *   job.name : 'sale.generatePdf' (pdfJobName('sale'))
 *   job.data : PdfJobData avec documentType: 'sale', documentId = Sale.id
 *
 * `requestedBy` (PdfJobData) n'est utilisé qu'à des fins de traçabilité/journalisation — aucun
 * contrôle d'accès ne s'appuie dessus, l'anti-IDOR est déjà couvert par
 * SaleService.findOne(documentId, organizationId) ci-dessous.
 */
@Processor('pdf')
export class SalePdfWorker extends WorkerHost {
  private readonly logger = new Logger(SalePdfWorker.name);

  constructor(
    private readonly saleService: SaleService,
    private readonly pdfService: PdfService,
    private readonly storageService: StorageService,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<PdfJobData>): Promise<void> {
    if (job.name !== pdfJobName('sale')) {
      this.logger.warn(`Job inconnu sur la file pdf : ${job.name}`);
      return;
    }

    const { organizationId, documentId } = job.data;
    if (!organizationId || !documentId) {
      this.logger.error('sale.generatePdf sans organizationId ou documentId — job ignoré');
      return;
    }

    try {
      const sale = await this.saleService.findOne(documentId, organizationId);
      const [productNames, branding] = await Promise.all([
        this.loadProductNames(
          organizationId,
          (sale.details ?? []).map((d) => d.productId),
        ),
        this.loadBranding(organizationId),
      ]);

      const content = renderSalePdfContent({
        reference: sale.reference,
        date: sale.date,
        status: sale.status,
        paymentStatus: sale.paymentStatus,
        clientName: sale.client?.name ?? null,
        warehouseName: sale.warehouse?.name ?? null,
        discount: sale.discount,
        taxAmount: sale.taxAmount,
        shipping: sale.shipping,
        grandTotal: sale.grandTotal,
        details: (sale.details ?? []).map((d) => ({
          productId: d.productId,
          productName: productNames.get(d.productId) ?? null,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      const html = wrapBrandedPdf(`Facture ${sale.reference}`, content, branding);
      const buffer = await this.pdfService.render(html);

      // Clé déterministe — écrase toute version précédente, pas d'accumulation d'objets S3
      // pour un même document (cf. session prompt S34).
      const key = `${organizationId}/pdf/sale/${documentId}.pdf`;
      await this.storageService.upload(key, buffer, 'application/pdf');
      const url = await this.storageService.getSignedUrl(key);

      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('pdf:ready', { documentType: 'sale', documentId, url });

      this.logger.log(`PDF de la vente ${documentId} généré et uploadé (${key})`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Vente introuvable (supprimée entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur une vente
        // qui n'existe plus.
        this.logger.warn(
          `sale.generatePdf : vente ${documentId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      this.logger.error(`sale.generatePdf : échec pour la vente ${documentId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('pdf:generateFailed', { documentType: 'sale', documentId });
      // Erreur inattendue (ex. échec Puppeteer/S3 transitoire) : on relance pour que BullMQ
      // retente (backoff configuré dans PdfQueueModule).
      throw err;
    }
  }

  /**
   * Charge les noms des produits référencés par une vente — SaleService.findOne ne renvoie
   * que productId ; le nom est chargé séparément ici via PrismaService (lecture ponctuelle,
   * pas de ProductService dédié importé pour ça). Mirror exact de sale-email.worker.ts.
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
   * ponctuelle via PrismaService, mirror de loadBranding dans sale-email.worker.ts avec `name`
   * en plus (affiché dans l'en-tête du document imprimé, cf. PdfOrganizationBranding).
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
