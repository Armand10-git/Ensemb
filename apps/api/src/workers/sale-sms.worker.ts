import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SaleService } from '../modules/sales/sale.service';
import { SmsService } from '../modules/messaging/sms.service';
import { renderSaleSmsBody } from '../modules/messaging/sale-message.renderer';

/**
 * Contrat du job de la file `sms` (S24 — récapitulatif de vente par SMS).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'sms'
 *   job.name : 'sale.sendSms'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire de la vente (§17 point 12)
 *     saleId: string;         // vente à récapituler
 *     to: string;             // numéro de téléphone destinataire — DÉJÀ validé par l'appelant
 *                              // (le contrôleur POST /api/v1/sales/:id/send) ; ce worker ne
 *                              // revalide pas le contact client, seulement la vente.
 *   }
 */
export interface SaleSmsJobData {
  organizationId: string;
  saleId: string;
  to: string;
}

/**
 * Worker BullMQ dédié à l'envoi par SMS d'un récapitulatif de vente (S24).
 * Tourne dans le process worker dédié (§17 point Z), jamais dans le process HTTP.
 *
 * Recharge la vente via SaleService.findOne (anti-IDOR déjà géré par SaleService), rend le
 * texte via renderSaleSmsBody (le corps SMS n'affiche pas le détail des lignes — pas besoin
 * des noms de produits, contrairement à sale-email.worker.ts), puis délègue l'envoi à
 * SmsService.sendSaleSummary (qui gère lui-même le mode test).
 */
@Processor('sms')
export class SaleSmsWorker extends WorkerHost {
  private readonly logger = new Logger(SaleSmsWorker.name);

  constructor(
    private readonly saleService: SaleService,
    private readonly smsService: SmsService,
  ) {
    super();
  }

  async process(job: Job<SaleSmsJobData>): Promise<void> {
    if (job.name !== 'sale.sendSms') {
      this.logger.warn(`Job inconnu sur la file sms : ${job.name}`);
      return;
    }

    const { organizationId, saleId, to } = job.data;
    if (!organizationId || !saleId || !to) {
      this.logger.error('sale.sendSms sans organizationId, saleId ou to — job ignoré');
      return;
    }

    try {
      const sale = await this.saleService.findOne(saleId, organizationId);

      const body = renderSaleSmsBody({
        reference: sale.reference,
        date: sale.date,
        paymentStatus: sale.paymentStatus,
        clientName: sale.client?.name ?? null,
        grandTotal: sale.grandTotal,
        details: (sale.details ?? []).map((d) => ({
          productId: d.productId,
          quantity: d.quantity,
          price: d.price,
          total: d.total,
        })),
      });

      await this.smsService.sendSaleSummary(organizationId, { to, body });

      this.logger.log(`Récapitulatif de vente ${saleId} envoyé par SMS à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Vente introuvable (supprimée entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur une vente
        // qui n'existe plus.
        this.logger.warn(
          `sale.sendSms : vente ${saleId} introuvable — job ignoré, pas de relance`,
        );
        return;
      }
      // Erreur inattendue (ex. échec Twilio transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      this.logger.error(`sale.sendSms : échec pour la vente ${saleId}`, err);
      throw err;
    }
  }
}
