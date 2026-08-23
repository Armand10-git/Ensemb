import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QuotationService } from '../modules/quotations/quotation.service';
import { EmailService } from '../modules/messaging/email.service';
import { PrismaService } from '../common/prisma.service';
import { renderQuotationEmailHtml } from '../modules/messaging/quotation-message.renderer';
import { wrapBrandedEmail } from '../modules/messaging/branded-email.template';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';

/**
 * Contrat du job de la file `email` (S28 — récapitulatif de devis par email).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'email'
 *   job.name : 'quotation.sendEmail'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire du devis (§17 point 12)
 *     quotationId: string;    // devis à récapituler
 *     to: string;             // adresse email destinataire — DÉJÀ validée par l'appelant
 *                              // (QuotationService.send / le contrôleur POST
 *                              // /api/v1/quotations/:id/send) ; ce worker ne revalide pas
 *                              // le contact client, seulement le devis.
 *   }
 */
export interface QuotationEmailJobData {
  organizationId: string;
  quotationId: string;
  to: string;
}

/**
 * Worker BullMQ dédié à l'envoi par email d'un récapitulatif de devis (S28).
 * Tourne dans le process worker dédié (§17 point Z), jamais dans le process HTTP.
 *
 * Recharge le devis via QuotationService.findOne (anti-IDOR déjà géré par QuotationService —
 * organizationId vérifié), charge les noms de produits séparément (QuotationService.findOne ne
 * renvoie que productId, cf. JSDoc de QuotationMessageLine dans quotation-message.renderer.ts),
 * rend le HTML via renderQuotationEmailHtml, puis délègue l'envoi à EmailService.sendQuotationSummary
 * (qui gère lui-même le mode test). Mirror exact de sale-email.worker.ts, sans paymentStatus
 * (un devis n'est jamais payé).
 */
@Processor('email')
export class QuotationEmailWorker extends WorkerHost {
  private readonly logger = new Logger(QuotationEmailWorker.name);

  constructor(
    private readonly quotationService: QuotationService,
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<QuotationEmailJobData>): Promise<void> {
    if (job.name !== 'quotation.sendEmail') {
      this.logger.warn(`Job inconnu sur la file email : ${job.name}`);
      return;
    }

    const { organizationId, quotationId, to } = job.data;
    if (!organizationId || !quotationId || !to) {
      this.logger.error('quotation.sendEmail sans organizationId, quotationId ou to — job ignoré');
      return;
    }

    try {
      const quotation = await this.quotationService.findOne(quotationId, organizationId);
      const [productNames, branding] = await Promise.all([
        this.loadProductNames(
          organizationId,
          (quotation.details ?? []).map((d) => d.productId),
        ),
        this.loadBranding(organizationId),
      ]);

      const content = renderQuotationEmailHtml({
        reference: quotation.reference,
        date: quotation.date,
        status: quotation.status,
        clientName: quotation.client?.name ?? null,
        grandTotal: quotation.grandTotal,
        details: (quotation.details ?? []).map((d) => ({
          productId: d.productId,
          productName: productNames.get(d.productId) ?? null,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      await this.emailService.sendQuotationSummary(organizationId, {
        to,
        subject: `Récapitulatif de devis ${quotation.reference}`,
        html: wrapBrandedEmail(content, branding),
      });

      this.logger.log(`Récapitulatif de devis ${quotationId} envoyé par email à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Devis introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un devis
        // qui n'existe plus.
        this.logger.warn(
          `quotation.sendEmail : devis ${quotationId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      this.logger.error(`quotation.sendEmail : échec pour le devis ${quotationId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('email:sendFailed', { jobName: job.name, reference: quotationId });
      // Erreur inattendue (ex. échec SMTP transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      throw err;
    }
  }

  /**
   * Charge les noms des produits référencés par un devis — QuotationService.findOne ne renvoie
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
