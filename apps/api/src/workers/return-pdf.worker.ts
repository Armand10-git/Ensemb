import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SaleReturnService } from '../modules/returns/sale-return.service';
import { PurchaseReturnService } from '../modules/returns/purchase-return.service';
import { PdfService } from '../modules/pdf/pdf.service';
import { StorageService } from '../modules/uploads/storage.service';
import { renderReturnPdfContent, type ReturnPdfKind } from '../modules/pdf/return-pdf.template';
import { wrapBrandedPdf, type PdfOrganizationBranding } from '../modules/pdf/branded-pdf.template';
import { PrismaService } from '../common/prisma.service';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';
import { pdfJobName, type PdfDocumentType, type PdfJobData } from '../modules/pdf/pdf-job.types';

/**
 * Worker BullMQ dédié à la génération PDF brandée d'un retour (S34) — couvre SaleReturn (retour
 * client) ET PurchaseReturn (retour fournisseur) selon job.name, un seul worker plutôt que deux
 * quasi identiques (mirrors exacts en base, cf. return-pdf.template.ts). Tourne dans le process
 * worker dédié (§17 point Z), jamais dans le process HTTP — Puppeteer (PdfService) est trop
 * coûteux en CPU/mémoire pour cohabiter avec le cycle requête/réponse.
 *
 * Recharge le retour via SaleReturnService.findOne/PurchaseReturnService.findOne (anti-IDOR déjà
 * géré — organizationId vérifié), charge les noms de produits et le nom du client/fournisseur
 * séparément (ni l'un ni l'autre service ne les expose — mirror exact du patron établi par
 * return-email.worker.ts : requête PrismaService supplémentaire sur Sale.client /
 * Purchase.provider), rend le contenu via renderReturnPdfContent, l'habille avec wrapBrandedPdf,
 * le convertit en PDF via PdfService.render, puis l'upload sur S3 (StorageService) avant
 * d'émettre l'URL signée en temps réel.
 */
@Processor('pdf')
export class ReturnPdfWorker extends WorkerHost {
  private readonly logger = new Logger(ReturnPdfWorker.name);

  constructor(
    private readonly saleReturnService: SaleReturnService,
    private readonly purchaseReturnService: PurchaseReturnService,
    private readonly pdfService: PdfService,
    private readonly storageService: StorageService,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<PdfJobData>): Promise<void> {
    if (job.name !== pdfJobName('saleReturn') && job.name !== pdfJobName('purchaseReturn')) {
      this.logger.warn(`Job inconnu sur la file pdf : ${job.name}`);
      return;
    }

    const documentType: PdfDocumentType =
      job.name === pdfJobName('saleReturn') ? 'saleReturn' : 'purchaseReturn';
    const kind: ReturnPdfKind = documentType === 'saleReturn' ? 'sale' : 'purchase';
    const { organizationId, documentId } = job.data;
    if (!organizationId || !documentId) {
      this.logger.error(`${job.name} sans organizationId ou documentId — job ignoré`);
      return;
    }

    try {
      const branding = await this.loadBranding(organizationId);
      const { reference, html: content } =
        kind === 'sale'
          ? await this.renderSaleReturnPdf(documentId, organizationId)
          : await this.renderPurchaseReturnPdf(documentId, organizationId);

      const title =
        kind === 'sale' ? `Retour de vente ${reference}` : `Retour fournisseur ${reference}`;
      const html = wrapBrandedPdf(title, content, branding);
      const buffer = await this.pdfService.render(html);

      const key = `${organizationId}/pdf/${documentType}/${documentId}.pdf`;
      await this.storageService.upload(key, buffer, 'application/pdf');
      const url = await this.storageService.getSignedUrl(key);

      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('pdf:ready', { documentType, documentId, url });

      this.logger.log(`PDF du retour ${documentId} généré et disponible sur ${key}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Retour introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un retour
        // qui n'existe plus.
        this.logger.warn(`${job.name} : retour ${documentId} introuvable — job ignoré, pas de relance`);
        return;
      }
      this.logger.error(`${job.name} : échec pour le retour ${documentId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('pdf:generateFailed', { documentType, documentId });
      // Erreur inattendue (ex. échec Puppeteer transitoire) : on relance pour que BullMQ
      // retente (defaultJobOptions.attempts, backoff exponentiel — cf. PdfQueueModule).
      throw err;
    }
  }

  private async renderSaleReturnPdf(
    documentId: string,
    organizationId: string,
  ): Promise<{ reference: string; html: string }> {
    const saleReturn = await this.saleReturnService.findOne(documentId, organizationId);
    const [productNames, sale] = await Promise.all([
      this.loadProductNames(
        organizationId,
        (saleReturn.details ?? []).map((d) => d.productId),
      ),
      this.prisma.sale.findUnique({
        where: { id: saleReturn.saleId },
        select: { client: { select: { name: true } } },
      }),
    ]);

    return {
      reference: saleReturn.reference,
      html: renderReturnPdfContent({
        kind: 'sale',
        reference: saleReturn.reference,
        date: saleReturn.date,
        status: saleReturn.status,
        paymentStatus: saleReturn.paymentStatus,
        originDocumentReference: saleReturn.sale?.reference ?? '',
        counterpartyName: sale?.client?.name ?? null,
        warehouseName: saleReturn.warehouse?.name ?? null,
        discount: saleReturn.discount,
        taxAmount: saleReturn.taxAmount,
        shipping: saleReturn.shipping,
        grandTotal: saleReturn.grandTotal,
        details: (saleReturn.details ?? []).map((d) => ({
          productId: d.productId,
          productName: productNames.get(d.productId) ?? null,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      }),
    };
  }

  private async renderPurchaseReturnPdf(
    documentId: string,
    organizationId: string,
  ): Promise<{ reference: string; html: string }> {
    const purchaseReturn = await this.purchaseReturnService.findOne(documentId, organizationId);
    const [productNames, purchase] = await Promise.all([
      this.loadProductNames(
        organizationId,
        (purchaseReturn.details ?? []).map((d) => d.productId),
      ),
      this.prisma.purchase.findUnique({
        where: { id: purchaseReturn.purchaseId },
        select: { provider: { select: { name: true } } },
      }),
    ]);

    return {
      reference: purchaseReturn.reference,
      html: renderReturnPdfContent({
        kind: 'purchase',
        reference: purchaseReturn.reference,
        date: purchaseReturn.date,
        status: purchaseReturn.status,
        paymentStatus: purchaseReturn.paymentStatus,
        originDocumentReference: purchaseReturn.purchase?.reference ?? '',
        counterpartyName: purchase?.provider?.name ?? null,
        warehouseName: purchaseReturn.warehouse?.name ?? null,
        discount: purchaseReturn.discount,
        taxAmount: purchaseReturn.taxAmount,
        shipping: purchaseReturn.shipping,
        grandTotal: purchaseReturn.grandTotal,
        details: (purchaseReturn.details ?? []).map((d) => ({
          productId: d.productId,
          productName: productNames.get(d.productId) ?? null,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      }),
    };
  }

  /**
   * Charge les noms des produits référencés par un retour — ni SaleReturnService.findOne ni
   * PurchaseReturnService.findOne ne renvoient le nom du produit ; chargé séparément ici via
   * PrismaService (lecture ponctuelle, mirror exact de return-email.worker.ts).
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
   * ponctuelle via PrismaService, mirror de loadBranding dans return-email.worker.ts, avec
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
