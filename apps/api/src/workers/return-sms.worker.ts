import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SaleReturnService } from '../modules/returns/sale-return.service';
import { PurchaseReturnService } from '../modules/returns/purchase-return.service';
import { SmsService } from '../modules/messaging/sms.service';
import {
  renderReturnSmsBody,
  type ReturnMessageKind,
} from '../modules/messaging/return-message.renderer';

/**
 * Contrat des jobs de la file `sms` (S33 — récapitulatif de retour par SMS).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'sms'
 *   job.name : 'saleReturn.sendSms' | 'purchaseReturn.sendSms'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire du retour (§17 point 12)
 *     returnId: string;       // SaleReturn.id ou PurchaseReturn.id selon job.name
 *     to: string;             // numéro de téléphone destinataire — DÉJÀ validé par l'appelant
 *                              // (SaleReturnService.send / PurchaseReturnService.send) ; ce
 *                              // worker ne revalide pas le contact, seulement le retour.
 *   }
 */
export interface ReturnSmsJobData {
  organizationId: string;
  returnId: string;
  to: string;
}

/**
 * Worker BullMQ dédié à l'envoi par SMS d'un récapitulatif de retour (S33) — couvre
 * SaleReturn (retour client) ET PurchaseReturn (retour fournisseur) selon job.name, mirror
 * simplifié de return-email.worker.ts : ni les noms de produits ni le nom de la contrepartie
 * ne sont chargés — renderReturnSmsBody ne les utilise pas (contrairement au rendu HTML), donc
 * SaleReturnService.findOne/PurchaseReturnService.findOne (anti-IDOR déjà géré) suffisent
 * seuls, sans PrismaService.
 */
@Processor('sms')
export class ReturnSmsWorker extends WorkerHost {
  private readonly logger = new Logger(ReturnSmsWorker.name);

  constructor(
    private readonly saleReturnService: SaleReturnService,
    private readonly purchaseReturnService: PurchaseReturnService,
    private readonly smsService: SmsService,
  ) {
    super();
  }

  async process(job: Job<ReturnSmsJobData>): Promise<void> {
    if (job.name !== 'saleReturn.sendSms' && job.name !== 'purchaseReturn.sendSms') {
      this.logger.warn(`Job inconnu sur la file sms : ${job.name}`);
      return;
    }

    const kind: ReturnMessageKind = job.name === 'saleReturn.sendSms' ? 'sale' : 'purchase';
    const { organizationId, returnId, to } = job.data;
    if (!organizationId || !returnId || !to) {
      this.logger.error(`${job.name} sans organizationId, returnId ou to — job ignoré`);
      return;
    }

    try {
      const body =
        kind === 'sale'
          ? await this.renderSaleReturn(returnId, organizationId)
          : await this.renderPurchaseReturn(returnId, organizationId);

      await this.smsService.sendReturnSummary(organizationId, { to, body });

      this.logger.log(`Récapitulatif de retour ${returnId} envoyé par SMS à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Retour introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un retour
        // qui n'existe plus.
        this.logger.warn(`${job.name} : retour ${returnId} introuvable — job ignoré, pas de relance`);
        return;
      }
      // Erreur inattendue (ex. échec Twilio transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      this.logger.error(`${job.name} : échec pour le retour ${returnId}`, err);
      throw err;
    }
  }

  private async renderSaleReturn(returnId: string, organizationId: string): Promise<string> {
    const saleReturn = await this.saleReturnService.findOne(returnId, organizationId);

    return renderReturnSmsBody({
      kind: 'sale',
      reference: saleReturn.reference,
      date: saleReturn.date,
      status: saleReturn.status,
      originDocumentReference: saleReturn.sale?.reference ?? '',
      counterpartyName: null,
      grandTotal: saleReturn.grandTotal,
      details: (saleReturn.details ?? []).map((d) => ({
        productId: d.productId,
        quantity: d.quantity,
        price: d.price,
        total: d.total,
      })),
    });
  }

  private async renderPurchaseReturn(returnId: string, organizationId: string): Promise<string> {
    const purchaseReturn = await this.purchaseReturnService.findOne(returnId, organizationId);

    return renderReturnSmsBody({
      kind: 'purchase',
      reference: purchaseReturn.reference,
      date: purchaseReturn.date,
      status: purchaseReturn.status,
      originDocumentReference: purchaseReturn.purchase?.reference ?? '',
      counterpartyName: null,
      grandTotal: purchaseReturn.grandTotal,
      details: (purchaseReturn.details ?? []).map((d) => ({
        productId: d.productId,
        quantity: d.quantity,
        price: d.price,
        total: d.total,
      })),
    });
  }
}
