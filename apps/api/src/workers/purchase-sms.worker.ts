import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PurchaseService } from '../modules/purchases/purchase.service';
import { SmsService } from '../modules/messaging/sms.service';
import { renderPurchaseSmsBody } from '../modules/messaging/purchase-message.renderer';

/**
 * Contrat du job de la file `sms` (S33 — récapitulatif d'achat par SMS).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'sms'
 *   job.name : 'purchase.sendSms'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire de l'achat (§17 point 12)
 *     purchaseId: string;     // achat à récapituler
 *     to: string;             // numéro de téléphone destinataire — DÉJÀ validé par l'appelant
 *                              // (le contrôleur POST /api/v1/purchases/:id/send) ; ce worker
 *                              // ne revalide pas le contact fournisseur, seulement l'achat.
 *   }
 */
export interface PurchaseSmsJobData {
  organizationId: string;
  purchaseId: string;
  to: string;
}

/**
 * Worker BullMQ dédié à l'envoi par SMS d'un récapitulatif d'achat (S33, mirror exact de
 * sale-sms.worker.ts). Tourne dans le process worker dédié (§17 point Z), jamais dans le
 * process HTTP.
 *
 * Recharge l'achat via PurchaseService.findOne (anti-IDOR déjà géré), rend le texte via
 * renderPurchaseSmsBody (le corps SMS n'affiche pas le détail des lignes ni le nom du
 * fournisseur — pas besoin de les charger, contrairement à purchase-email.worker.ts), puis
 * délègue l'envoi à SmsService.sendPurchaseSummary (qui gère lui-même le mode test).
 */
@Processor('sms')
export class PurchaseSmsWorker extends WorkerHost {
  private readonly logger = new Logger(PurchaseSmsWorker.name);

  constructor(
    private readonly purchaseService: PurchaseService,
    private readonly smsService: SmsService,
  ) {
    super();
  }

  async process(job: Job<PurchaseSmsJobData>): Promise<void> {
    if (job.name !== 'purchase.sendSms') {
      this.logger.warn(`Job inconnu sur la file sms : ${job.name}`);
      return;
    }

    const { organizationId, purchaseId, to } = job.data;
    if (!organizationId || !purchaseId || !to) {
      this.logger.error('purchase.sendSms sans organizationId, purchaseId ou to — job ignoré');
      return;
    }

    try {
      const purchase = await this.purchaseService.findOne(purchaseId, organizationId);

      const body = renderPurchaseSmsBody({
        reference: purchase.reference,
        date: purchase.date,
        paymentStatus: purchase.paymentStatus,
        providerName: purchase.provider?.name ?? null,
        grandTotal: purchase.grandTotal,
        details: (purchase.details ?? []).map((d) => ({
          productId: d.productId,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      await this.smsService.sendPurchaseSummary(organizationId, { to, body });

      this.logger.log(`Récapitulatif d'achat ${purchaseId} envoyé par SMS à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Achat introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un achat
        // qui n'existe plus.
        this.logger.warn(
          `purchase.sendSms : achat ${purchaseId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      // Erreur inattendue (ex. échec Twilio transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      this.logger.error(`purchase.sendSms : échec pour l'achat ${purchaseId}`, err);
      throw err;
    }
  }
}
