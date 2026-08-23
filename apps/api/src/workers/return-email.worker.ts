import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SaleReturnService } from '../modules/returns/sale-return.service';
import { PurchaseReturnService } from '../modules/returns/purchase-return.service';
import { EmailService } from '../modules/messaging/email.service';
import {
  renderReturnEmailHtml,
  type ReturnMessageKind,
} from '../modules/messaging/return-message.renderer';
import { wrapBrandedEmail } from '../modules/messaging/branded-email.template';
import { PrismaService } from '../common/prisma.service';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';

/**
 * Contrat des jobs de la file `email` (S32 — récapitulatif de retour par email).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'email'
 *   job.name : 'saleReturn.sendEmail' | 'purchaseReturn.sendEmail'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire du retour (§17 point 12)
 *     returnId: string;       // SaleReturn.id ou PurchaseReturn.id selon job.name
 *     to: string;             // adresse email destinataire — DÉJÀ validée par l'appelant
 *                              // (SaleReturnService.send / PurchaseReturnService.send) ; ce
 *                              // worker ne revalide pas le contact, seulement le retour.
 *   }
 */
export interface ReturnEmailJobData {
  organizationId: string;
  returnId: string;
  to: string;
}

/**
 * Worker BullMQ dédié à l'envoi par email d'un récapitulatif de retour (S32) — couvre
 * SaleReturn (retour client) ET PurchaseReturn (retour fournisseur) selon job.name, un seul
 * worker plutôt que deux quasi identiques (mirror exacts en base, cf. return-message.renderer.ts).
 *
 * Recharge le retour via SaleReturnService.findOne/PurchaseReturnService.findOne (anti-IDOR déjà
 * géré — organizationId vérifié), charge les noms de produits et le nom du client/fournisseur
 * séparément (ni l'un ni l'autre service ne les expose — mirror du patron loadProductNames des
 * autres workers), rend le HTML via renderReturnEmailHtml, l'habille avec le branding de
 * l'organisation, puis délègue l'envoi à EmailService.sendReturnSummary (qui gère lui-même le
 * mode test).
 */
@Processor('email')
export class ReturnEmailWorker extends WorkerHost {
  private readonly logger = new Logger(ReturnEmailWorker.name);

  constructor(
    private readonly saleReturnService: SaleReturnService,
    private readonly purchaseReturnService: PurchaseReturnService,
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<ReturnEmailJobData>): Promise<void> {
    if (job.name !== 'saleReturn.sendEmail' && job.name !== 'purchaseReturn.sendEmail') {
      this.logger.warn(`Job inconnu sur la file email : ${job.name}`);
      return;
    }

    const kind: ReturnMessageKind = job.name === 'saleReturn.sendEmail' ? 'sale' : 'purchase';
    const { organizationId, returnId, to } = job.data;
    if (!organizationId || !returnId || !to) {
      this.logger.error(`${job.name} sans organizationId, returnId ou to — job ignoré`);
      return;
    }

    try {
      const branding = await this.loadBranding(organizationId);
      const content =
        kind === 'sale'
          ? await this.renderSaleReturn(returnId, organizationId)
          : await this.renderPurchaseReturn(returnId, organizationId);

      await this.emailService.sendReturnSummary(organizationId, {
        to,
        subject: `Récapitulatif de retour ${content.reference}`,
        html: wrapBrandedEmail(content.html, branding),
      });

      this.logger.log(`Récapitulatif de retour ${returnId} envoyé par email à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Retour introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un retour
        // qui n'existe plus.
        this.logger.warn(`${job.name} : retour ${returnId} introuvable — job ignoré, pas de relance`);
        return;
      }
      this.logger.error(`${job.name} : échec pour le retour ${returnId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('email:sendFailed', { jobName: job.name, reference: returnId });
      // Erreur inattendue (ex. échec SMTP transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      throw err;
    }
  }

  private async renderSaleReturn(
    returnId: string,
    organizationId: string,
  ): Promise<{ reference: string; html: string }> {
    const saleReturn = await this.saleReturnService.findOne(returnId, organizationId);
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
      html: renderReturnEmailHtml({
        kind: 'sale',
        reference: saleReturn.reference,
        date: saleReturn.date,
        status: saleReturn.status,
        originDocumentReference: saleReturn.sale?.reference ?? '',
        counterpartyName: sale?.client?.name ?? null,
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

  private async renderPurchaseReturn(
    returnId: string,
    organizationId: string,
  ): Promise<{ reference: string; html: string }> {
    const purchaseReturn = await this.purchaseReturnService.findOne(returnId, organizationId);
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
      html: renderReturnEmailHtml({
        kind: 'purchase',
        reference: purchaseReturn.reference,
        date: purchaseReturn.date,
        status: purchaseReturn.status,
        originDocumentReference: purchaseReturn.purchase?.reference ?? '',
        counterpartyName: purchase?.provider?.name ?? null,
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
   * PrismaService (lecture ponctuelle, mirror exact de sale-email.worker.ts).
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
   * Charge le logo/couleur de l'organisation pour l'habillage brandé (S32) — lecture
   * ponctuelle via PrismaService, mirror des autres workers email de cette session.
   */
  private async loadBranding(
    organizationId: string,
  ): Promise<{ logoUrl: string | null; primaryColor: string | null }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { logoUrl: true, primaryColor: true },
    });
    return { logoUrl: org?.logoUrl ?? null, primaryColor: org?.primaryColor ?? null };
  }
}
