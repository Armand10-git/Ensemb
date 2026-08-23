import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../common/prisma.service';
import { EmailService } from '../modules/messaging/email.service';
import {
  renderPaymentReceiptEmailHtml,
  type PaymentReceiptKind,
} from '../modules/messaging/payment-receipt-message.renderer';
import { wrapBrandedEmail } from '../modules/messaging/branded-email.template';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway';

/**
 * Contrat des jobs de la file `email` (S32 — reçu de paiement par email).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker.
 *
 *   queue : 'email'
 *   job.name : 'paymentSale.sendEmail' | 'paymentPurchase.sendEmail'
 *   job.data : {
 *     organizationId: string; // organisation propriétaire du paiement (§17 point 12)
 *     paymentId: string;      // PaymentSale.id ou PaymentPurchase.id selon job.name
 *     to: string;             // adresse email destinataire — DÉJÀ validée par l'appelant
 *                              // (PaymentSaleService.send / PaymentPurchaseService.send) ;
 *                              // ce worker ne revalide pas le contact, seulement le paiement.
 *   }
 */
export interface PaymentReceiptEmailJobData {
  organizationId: string;
  paymentId: string;
  to: string;
}

const SELECT_PAYMENT_SALE = {
  id: true,
  reference: true,
  date: true,
  amount: true,
  method: true,
  change: true,
  sale: { select: { reference: true, client: { select: { name: true } } } },
} as const;

const SELECT_PAYMENT_PURCHASE = {
  id: true,
  reference: true,
  date: true,
  amount: true,
  method: true,
  change: true,
  purchase: { select: { reference: true, provider: { select: { name: true } } } },
} as const;

/**
 * Worker BullMQ dédié à l'envoi par email d'un reçu de paiement (S32) — couvre PaymentSale
 * (encaissement de vente) ET PaymentPurchase (règlement fournisseur) selon job.name, un seul
 * worker plutôt que deux quasi identiques (mirror exacts en base, cf. payment-receipt-message.renderer.ts).
 *
 * Recharge le paiement directement via PrismaService (organizationId vérifié explicitement,
 * ni PaymentSaleService.findOne ni PaymentPurchaseService.findOne n'exposent le nom du
 * client/fournisseur — lecture ponctuelle avec le bon include, mirror du patron
 * loadProductNames des autres workers), rend le HTML via renderPaymentReceiptEmailHtml,
 * l'habille avec le branding de l'organisation, puis délègue l'envoi à
 * EmailService.sendPaymentReceipt (qui gère lui-même le mode test).
 */
@Processor('email')
export class PaymentReceiptEmailWorker extends WorkerHost {
  private readonly logger = new Logger(PaymentReceiptEmailWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<PaymentReceiptEmailJobData>): Promise<void> {
    if (job.name !== 'paymentSale.sendEmail' && job.name !== 'paymentPurchase.sendEmail') {
      this.logger.warn(`Job inconnu sur la file email : ${job.name}`);
      return;
    }

    const kind: PaymentReceiptKind = job.name === 'paymentSale.sendEmail' ? 'sale' : 'purchase';
    const { organizationId, paymentId, to } = job.data;
    if (!organizationId || !paymentId || !to) {
      this.logger.error(`${job.name} sans organizationId, paymentId ou to — job ignoré`);
      return;
    }

    try {
      const branding = await this.loadBranding(organizationId);
      const content =
        kind === 'sale'
          ? await this.renderSalePayment(paymentId, organizationId)
          : await this.renderPurchasePayment(paymentId, organizationId);

      await this.emailService.sendPaymentReceipt(organizationId, {
        to,
        subject: `Reçu de paiement ${content.reference}`,
        html: wrapBrandedEmail(content.html, branding),
      });

      this.logger.log(`Reçu de paiement ${paymentId} envoyé par email à ${to}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Paiement introuvable (supprimé entre l'enfilage et le traitement du job) — cas de
        // compétition improbable mais géré proprement : pas de retry infini sur un paiement
        // qui n'existe plus.
        this.logger.warn(`${job.name} : paiement ${paymentId} introuvable — job ignoré, pas de relance`);
        return;
      }
      this.logger.error(`${job.name} : échec pour le paiement ${paymentId}`, err);
      this.realtimeGateway.server
        ?.to(`org:${organizationId}`)
        .emit('email:sendFailed', { jobName: job.name, reference: paymentId });
      // Erreur inattendue (ex. échec SMTP transitoire) : on relance pour que BullMQ retente
      // (defaultJobOptions.attempts = 3, backoff exponentiel — cf. MessagingQueueModule).
      throw err;
    }
  }

  private async renderSalePayment(
    paymentId: string,
    organizationId: string,
  ): Promise<{ reference: string; html: string }> {
    const payment = await this.prisma.paymentSale.findUnique({
      where: { id: paymentId },
      select: { ...SELECT_PAYMENT_SALE, organizationId: true },
    });
    if (!payment || payment.organizationId !== organizationId) {
      throw new NotFoundException('Paiement introuvable.');
    }

    return {
      reference: payment.reference,
      html: renderPaymentReceiptEmailHtml({
        kind: 'sale',
        reference: payment.reference,
        date: payment.date,
        amount: payment.amount,
        method: payment.method,
        change: payment.change,
        documentReference: payment.sale.reference,
        counterpartyName: payment.sale.client?.name ?? null,
      }),
    };
  }

  private async renderPurchasePayment(
    paymentId: string,
    organizationId: string,
  ): Promise<{ reference: string; html: string }> {
    const payment = await this.prisma.paymentPurchase.findUnique({
      where: { id: paymentId },
      select: { ...SELECT_PAYMENT_PURCHASE, organizationId: true },
    });
    if (!payment || payment.organizationId !== organizationId) {
      throw new NotFoundException('Paiement introuvable.');
    }

    return {
      reference: payment.reference,
      html: renderPaymentReceiptEmailHtml({
        kind: 'purchase',
        reference: payment.reference,
        date: payment.date,
        amount: payment.amount,
        method: payment.method,
        change: payment.change,
        documentReference: payment.purchase.reference,
        counterpartyName: payment.purchase.provider?.name ?? null,
      }),
    };
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
