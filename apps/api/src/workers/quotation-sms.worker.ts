import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QuotationService } from '../modules/quotations/quotation.service';
import { SmsService } from '../modules/messaging/sms.service';
import { renderQuotationSmsBody } from '../modules/messaging/quotation-message.renderer';

/**
 * Contrat du job de la file `sms` (S28 — récapitulatif de devis par SMS).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'sms'
 *   job.name : 'quotation.sendSms'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire du devis (§17 point 12)
 *     quotationId: string;    // devis à récapituler
 *     to: string;             // numéro de téléphone destinataire — DÉJÀ validé par l'appelant
 *                              // (QuotationService.send / le contrôleur POST
 *                              // /api/v1/quotations/:id/send) ; ce worker ne revalide pas
 *                              // le contact client, seulement le devis.
 *   }
 */
export interface QuotationSmsJobData {
  organizationId: string;
  quotationId: string;
  to: string;
}

/**
 * Worker BullMQ dédié à l'envoi par SMS d'un récapitulatif de devis (S28).
 * Tourne dans le process worker dédié (§17 point Z), jamais dans le process HTTP.
 *
 * Recharge le devis via QuotationService.findOne (anti-IDOR déjà géré par QuotationService), rend
 * le texte via renderQuotationSmsBody (le corps SMS n'affiche pas le détail des lignes — pas
 * besoin des noms de produits, contrairement à quotation-email.worker.ts), puis délègue l'envoi
 * à SmsService.sendQuotationSummary (qui gère lui-même le mode test). Mirror exact de
 * sale-sms.worker.ts, sans paymentStatus (un devis n'est jamais payé).
 */
@Processor('sms')
export class QuotationSmsWorker extends WorkerHost {
  private readonly logger = new Logger(QuotationSmsWorker.name);

  constructor(
    private readonly quotationService: QuotationService,
    private readonly smsService: SmsService,
  ) {
    super();
  }

  async process(job: Job<QuotationSmsJobData>): Promise<void> {
    if (job.name !== 'quotation.sendSms') {
      this.logger.warn(`Job inconnu sur la file sms : ${job.name}`);
      return;
    }

    const { organizationId, quotationId, to } = job.data;
    if (!organizationId || !quotationId || !to) {
      this.logger.error('quotation.sendSms sans organizationId, quotationId ou to — job ignoré');
      return;
    }

    try {
      const quotation = await this.quotationService.findOne(quotationId, organizationId);

      const body = renderQuotationSmsBody({
        reference: quotation.reference,
        date: quotation.date,
        status: quotation.status,
        clientName: quotation.client?.name ?? null,
        grandTotal: quotation.grandTotal,
        details: (quotation.details ?? []).map((d) => ({
          productId: d.productId,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      await this.smsService.sendQuotationSummary(organizationId, { to, body });

      this.logger.log(`Récapitulatif de devis ${quotationId} envoyé par SMS à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Devis introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un devis
        // qui n'existe plus.
        this.logger.warn(
          `quotation.sendSms : devis ${quotationId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      // Erreur inattendue (ex. échec Twilio transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      this.logger.error(`quotation.sendSms : échec pour le devis ${quotationId}`, err);
      throw err;
    }
  }
}
