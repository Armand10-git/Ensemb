import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { BillingService, type BillingJobData } from '../modules/billing/billing.service';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';

/**
 * Worker BullMQ dédié à la facturation récurrente.
 * Tourne dans un process distinct du serveur HTTP (§17 point Z).
 *
 * Jobs gérés :
 * - invoice.expire   : expire une facture non confirmée sous 24h
 * - invoice.renew    : génère une nouvelle facture à l'échéance
 * - billing.checkTrialCap : vérifie le plafond de CA d'essai
 *
 * Invariant : chaque job transporte son organizationId — jamais de requête cross-tenant.
 */
@Processor('billing')
export class BillingWorker extends WorkerHost {
  private readonly logger = new Logger(BillingWorker.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<BillingJobData>): Promise<void> {
    const { organizationId } = job.data;

    if (!organizationId) {
      this.logger.error(`Job ${job.name} sans organizationId — ignoré`);
      return;
    }

    switch (job.name) {
      case 'invoice.expire':
        await this.handleExpire(job.data);
        break;
      case 'invoice.renew':
        await this.handleRenew(job.data);
        break;
      case 'billing.checkTrialCap':
        await this.handleCheckTrialCap(job.data);
        break;
      default:
        this.logger.warn(`Job inconnu : ${job.name}`);
    }
  }

  /**
   * Expire une Invoice PENDING non confirmée sous 24h.
   * Passe Invoice → FAILED, Subscription → PAST_DUE, émet un événement Socket.io.
   */
  private async handleExpire(data: BillingJobData): Promise<void> {
    const { invoiceId, organizationId } = data;
    if (!invoiceId) {
      this.logger.error('invoice.expire sans invoiceId');
      return;
    }

    try {
      await this.billingService.expireInvoice(invoiceId, organizationId);

      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('organization:subscriptionExpired', { organizationId, invoiceId });

      this.logger.log(`Invoice ${invoiceId} expirée pour ${organizationId}`);
    } catch (err) {
      this.logger.error(`Erreur lors de l'expiration de l'Invoice ${invoiceId}`, err);
      throw err; // BullMQ retentera le job
    }
  }

  /**
   * Renouvelle l'abonnement en régénérant une facture et un lien de paiement.
   * Envoie un "email" (stub : log serveur tant que NotificationsModule est absent).
   */
  private async handleRenew(data: BillingJobData): Promise<void> {
    const { organizationId, planId, period } = data;
    if (!planId || !period) {
      this.logger.error('invoice.renew sans planId ou period');
      return;
    }

    try {
      const { invoiceId, paymentUrl } = await this.billingService.createPaymentLink(
        organizationId,
        planId,
        period as 'monthly' | 'annual',
      );

      // Stub email — remplacer par NotificationsModule (S30b ou ultérieur)
      this.logger.log(
        `[EMAIL STUB] Renouvellement pour ${organizationId} — Invoice ${invoiceId}, lien : ${paymentUrl}`,
      );
    } catch (err) {
      this.logger.error(`Erreur lors du renouvellement pour ${organizationId}`, err);
      throw err;
    }
  }

  /**
   * Vérifie si le CA cumulé de l'organisation dépasse le plafond d'essai.
   * Si oui, passe la Subscription en PAST_DUE et émet un événement Socket.io.
   */
  private async handleCheckTrialCap(data: BillingJobData): Promise<void> {
    const { organizationId } = data;

    try {
      const subscriptionBefore = await this.billingService.getSubscription(organizationId);
      await this.billingService.checkTrialCap(organizationId);
      const subscriptionAfter = await this.billingService.getSubscription(organizationId);

      if (subscriptionBefore.status === 'TRIALING' && subscriptionAfter.status === 'PAST_DUE') {
        this.realtimeGateway.server
          ?.to(`org:${organizationId}`)
          .emit('organization:trialCapReached', { organizationId });

        this.logger.log(`Plafond CA atteint pour ${organizationId} — PAST_DUE émis`);
      }
    } catch (err) {
      this.logger.error(`Erreur lors du checkTrialCap pour ${organizationId}`, err);
      throw err;
    }
  }
}
