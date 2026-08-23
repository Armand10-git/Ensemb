import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../common/prisma.service';
import { SmsService } from '../modules/messaging/sms.service';
import {
  renderPaymentReceiptSmsBody,
  type PaymentReceiptKind,
} from '../modules/messaging/payment-receipt-message.renderer';

/**
 * Contrat des jobs de la file `sms` (S33 — reçu de paiement par SMS).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'sms'
 *   job.name : 'paymentSale.sendSms' | 'paymentPurchase.sendSms'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire du paiement (§17 point 12)
 *     paymentId: string;      // PaymentSale.id ou PaymentPurchase.id selon job.name
 *     to: string;             // numéro de téléphone destinataire — DÉJÀ validé par l'appelant
 *                              // (PaymentSaleService.send / PaymentPurchaseService.send) ;
 *                              // ce worker ne revalide pas le contact, seulement le paiement.
 *   }
 */
export interface PaymentReceiptSmsJobData {
  organizationId: string;
  paymentId: string;
  to: string;
}

const SELECT_PAYMENT_SALE = {
  id: true,
  reference: true,
  date: true,
  amount: true,
  sale: { select: { reference: true } },
} as const;

const SELECT_PAYMENT_PURCHASE = {
  id: true,
  reference: true,
  date: true,
  amount: true,
  purchase: { select: { reference: true } },
} as const;

/**
 * Worker BullMQ dédié à l'envoi par SMS d'un reçu de paiement (S33) — couvre PaymentSale
 * (encaissement de vente) ET PaymentPurchase (règlement fournisseur) selon job.name, mirror
 * simplifié de payment-receipt-email.worker.ts (pas de branding/HTML, pas de nom de
 * contrepartie — renderPaymentReceiptSmsBody ne les utilise pas).
 *
 * Recharge le paiement directement via PrismaService (organizationId vérifié explicitement,
 * ni PaymentSaleService.findOne ni PaymentPurchaseService.findOne n'exposent ce dont ce
 * worker a besoin), rend le corps texte via renderPaymentReceiptSmsBody, puis délègue l'envoi
 * à SmsService.sendPaymentReceipt (qui gère lui-même le mode test).
 */
@Processor('sms')
export class PaymentReceiptSmsWorker extends WorkerHost {
  private readonly logger = new Logger(PaymentReceiptSmsWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
  ) {
    super();
  }

  async process(job: Job<PaymentReceiptSmsJobData>): Promise<void> {
    if (job.name !== 'paymentSale.sendSms' && job.name !== 'paymentPurchase.sendSms') {
      this.logger.warn(`Job inconnu sur la file sms : ${job.name}`);
      return;
    }

    const kind: PaymentReceiptKind = job.name === 'paymentSale.sendSms' ? 'sale' : 'purchase';
    const { organizationId, paymentId, to } = job.data;
    if (!organizationId || !paymentId || !to) {
      this.logger.error(`${job.name} sans organizationId, paymentId ou to — job ignoré`);
      return;
    }

    try {
      const body =
        kind === 'sale'
          ? await this.renderSalePayment(paymentId, organizationId)
          : await this.renderPurchasePayment(paymentId, organizationId);

      await this.smsService.sendPaymentReceipt(organizationId, { to, body });

      this.logger.log(`Reçu de paiement ${paymentId} envoyé par SMS à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Paiement introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un paiement
        // qui n'existe plus.
        this.logger.warn(`${job.name} : paiement ${paymentId} introuvable — job ignoré, pas de relance`);
        return;
      }
      // Erreur inattendue (ex. échec Twilio transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      this.logger.error(`${job.name} : échec pour le paiement ${paymentId}`, err);
      throw err;
    }
  }

  private async renderSalePayment(paymentId: string, organizationId: string): Promise<string> {
    const payment = await this.prisma.paymentSale.findUnique({
      where: { id: paymentId },
      select: { ...SELECT_PAYMENT_SALE, organizationId: true },
    });
    if (!payment || payment.organizationId !== organizationId) {
      throw new NotFoundException('Paiement introuvable.');
    }

    return renderPaymentReceiptSmsBody({
      kind: 'sale',
      reference: payment.reference,
      date: payment.date,
      amount: payment.amount,
      method: '',
      documentReference: payment.sale.reference,
      counterpartyName: null,
    });
  }

  private async renderPurchasePayment(paymentId: string, organizationId: string): Promise<string> {
    const payment = await this.prisma.paymentPurchase.findUnique({
      where: { id: paymentId },
      select: { ...SELECT_PAYMENT_PURCHASE, organizationId: true },
    });
    if (!payment || payment.organizationId !== organizationId) {
      throw new NotFoundException('Paiement introuvable.');
    }

    return renderPaymentReceiptSmsBody({
      kind: 'purchase',
      reference: payment.reference,
      date: payment.date,
      amount: payment.amount,
      method: '',
      documentReference: payment.purchase.reference,
      counterpartyName: null,
    });
  }
}
