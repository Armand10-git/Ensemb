import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SaleService } from '../modules/sales/sale.service';
import { EmailService } from '../modules/messaging/email.service';
import { PrismaService } from '../common/prisma.service';
import { renderSaleEmailHtml } from '../modules/messaging/sale-message.renderer';
import { wrapBrandedEmail } from '../modules/messaging/branded-email.template';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';

/**
 * Contrat du job de la file `email` (S24 — récapitulatif de vente par email).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'email'
 *   job.name : 'sale.sendEmail'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire de la vente (§17 point 12)
 *     saleId: string;         // vente à récapituler
 *     to: string;             // adresse email destinataire — DÉJÀ validée par l'appelant
 *                              // (le contrôleur POST /api/v1/sales/:id/send) ; ce worker ne
 *                              // revalide pas le contact client, seulement la vente.
 *   }
 */
export interface SaleEmailJobData {
  organizationId: string;
  saleId: string;
  to: string;
}

/**
 * Worker BullMQ dédié à l'envoi par email d'un récapitulatif de vente (S24).
 * Tourne dans le process worker dédié (§17 point Z), jamais dans le process HTTP.
 *
 * Recharge la vente via SaleService.findOne (anti-IDOR déjà géré par SaleService — organizationId
 * vérifié), charge les noms de produits séparément (SaleService.findOne ne renvoie que productId,
 * cf. JSDoc de SaleMessageLine dans sale-message.renderer.ts), rend le HTML via
 * renderSaleEmailHtml, puis délègue l'envoi à EmailService.sendSaleSummary (qui gère lui-même
 * le mode test).
 */
@Processor('email')
export class SaleEmailWorker extends WorkerHost {
  private readonly logger = new Logger(SaleEmailWorker.name);

  constructor(
    private readonly saleService: SaleService,
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<SaleEmailJobData>): Promise<void> {
    if (job.name !== 'sale.sendEmail') {
      this.logger.warn(`Job inconnu sur la file email : ${job.name}`);
      return;
    }

    const { organizationId, saleId, to } = job.data;
    if (!organizationId || !saleId || !to) {
      this.logger.error('sale.sendEmail sans organizationId, saleId ou to — job ignoré');
      return;
    }

    try {
      const sale = await this.saleService.findOne(saleId, organizationId);
      const [productNames, branding] = await Promise.all([
        this.loadProductNames(
          organizationId,
          (sale.details ?? []).map((d) => d.productId),
        ),
        this.loadBranding(organizationId),
      ]);

      const content = renderSaleEmailHtml({
        reference: sale.reference,
        date: sale.date,
        paymentStatus: sale.paymentStatus,
        clientName: sale.client?.name ?? null,
        grandTotal: sale.grandTotal,
        details: (sale.details ?? []).map((d) => ({
          productId: d.productId,
          productName: productNames.get(d.productId) ?? null,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      await this.emailService.sendSaleSummary(organizationId, {
        to,
        subject: `Récapitulatif de vente ${sale.reference}`,
        html: wrapBrandedEmail(content, branding),
      });

      this.logger.log(`Récapitulatif de vente ${saleId} envoyé par email à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Vente introuvable (supprimée entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur une vente
        // qui n'existe plus.
        this.logger.warn(
          `sale.sendEmail : vente ${saleId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      this.logger.error(`sale.sendEmail : échec pour la vente ${saleId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('email:sendFailed', { jobName: job.name, reference: saleId });
      // Erreur inattendue (ex. échec SMTP transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      throw err;
    }
  }

  /**
   * Charge les noms des produits référencés par une vente — SaleService.findOne ne renvoie
   * que productId ; le nom est chargé séparément ici via PrismaService (lecture ponctuelle,
   * pas de ProductService dédié importé pour ça).
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
   * ponctuelle via PrismaService, mirror de loadProductNames ci-dessus.
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
