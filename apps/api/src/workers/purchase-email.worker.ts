import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PurchaseService } from '../modules/purchases/purchase.service';
import { EmailService } from '../modules/messaging/email.service';
import { PrismaService } from '../common/prisma.service';
import { renderPurchaseEmailHtml } from '../modules/messaging/purchase-message.renderer';
import { wrapBrandedEmail } from '../modules/messaging/branded-email.template';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';

/**
 * Contrat du job de la file `email` (S32 — récapitulatif d'achat par email).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'email'
 *   job.name : 'purchase.sendEmail'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire de l'achat (§17 point 12)
 *     purchaseId: string;     // achat à récapituler
 *     to: string;             // adresse email destinataire — DÉJÀ validée par l'appelant
 *                              // (le contrôleur POST /api/v1/purchases/:id/send) ; ce worker
 *                              // ne revalide pas le contact fournisseur, seulement l'achat.
 *   }
 */
export interface PurchaseEmailJobData {
  organizationId: string;
  purchaseId: string;
  to: string;
}

/**
 * Worker BullMQ dédié à l'envoi par email d'un récapitulatif d'achat (S32).
 * Tourne dans le process worker dédié (§17 point Z), jamais dans le process HTTP.
 *
 * Recharge l'achat via PurchaseService.findOne (anti-IDOR déjà géré par PurchaseService —
 * organizationId vérifié), charge les noms de produits séparément (mirror exact de
 * sale-email.worker.ts), rend le HTML via renderPurchaseEmailHtml, l'habille avec le
 * branding de l'organisation (wrapBrandedEmail, S32), puis délègue l'envoi à
 * EmailService.sendPurchaseSummary (qui gère lui-même le mode test).
 */
@Processor('email')
export class PurchaseEmailWorker extends WorkerHost {
  private readonly logger = new Logger(PurchaseEmailWorker.name);

  constructor(
    private readonly purchaseService: PurchaseService,
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<PurchaseEmailJobData>): Promise<void> {
    if (job.name !== 'purchase.sendEmail') {
      this.logger.warn(`Job inconnu sur la file email : ${job.name}`);
      return;
    }

    const { organizationId, purchaseId, to } = job.data;
    if (!organizationId || !purchaseId || !to) {
      this.logger.error('purchase.sendEmail sans organizationId, purchaseId ou to — job ignoré');
      return;
    }

    try {
      const purchase = await this.purchaseService.findOne(purchaseId, organizationId);
      const [productNames, branding] = await Promise.all([
        this.loadProductNames(
          organizationId,
          (purchase.details ?? []).map((d) => d.productId),
        ),
        this.loadBranding(organizationId),
      ]);

      const content = renderPurchaseEmailHtml({
        reference: purchase.reference,
        date: purchase.date,
        paymentStatus: purchase.paymentStatus,
        providerName: purchase.provider?.name ?? null,
        grandTotal: purchase.grandTotal,
        details: (purchase.details ?? []).map((d) => ({
          productId: d.productId,
          productName: productNames.get(d.productId) ?? null,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      await this.emailService.sendPurchaseSummary(organizationId, {
        to,
        subject: `Récapitulatif d'achat ${purchase.reference}`,
        html: wrapBrandedEmail(content, branding),
      });

      this.logger.log(`Récapitulatif d'achat ${purchaseId} envoyé par email à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Achat introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un achat
        // qui n'existe plus.
        this.logger.warn(
          `purchase.sendEmail : achat ${purchaseId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      this.logger.error(`purchase.sendEmail : échec pour l'achat ${purchaseId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('email:sendFailed', { jobName: job.name, reference: purchaseId });
      // Erreur inattendue (ex. échec SMTP transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      throw err;
    }
  }

  /**
   * Charge les noms des produits référencés par un achat — PurchaseService.findOne ne renvoie
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
   * Charge le logo/couleur de l'organisation pour l'habillage brandé (S32) — lecture
   * ponctuelle via PrismaService, mirror de loadProductNames ci-dessus (pas de service dédié
   * importé juste pour ces deux colonnes).
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
