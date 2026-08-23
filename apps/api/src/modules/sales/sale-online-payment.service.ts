import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../common/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PaymentSaleService, type PaymentSaleResponse } from './payment-sale.service';
import { AsyncPaymentService } from '../payment-gateway/async-payment.service';
import {
  mapProviderToPaymentMethod,
  type AggregatorPaymentConfirmation,
} from '../payment-gateway/payment-provider.util';

/** Délai par défaut avant expiration d'une intention de paiement en ligne (15 min — pas de comptoir physique à bloquer, contrairement au POS). */
const DEFAULT_SALE_ONLINE_PAYMENT_TIMEOUT_MS = 900_000;

/** Payload de la file BullMQ `sale-online-payment-expiration`. */
export interface SaleOnlinePaymentExpirationJobPayload {
  intentId: string;
  organizationId: string;
}

/** Réponse de initiate() — de quoi construire l'écran d'attente de paiement côté client. */
export interface InitiateOnlinePaymentResult {
  intentId: string;
  paymentLink: string;
  expiresAt: Date;
}

/**
 * Paiement en ligne (agrégateur — CARD/ORANGE_MONEY/MTN_MOMO) sur une vente classique
 * (S31, §17 point V).
 *
 * Décision de conception actée (contexte, cf. prompt de session) : une vente classique
 * décrémente son stock à validate() (S21), totalement DÉCOUPLÉ de l'encaissement (S20) —
 * un paiement en ligne différé n'a donc RIEN à restituer côté stock s'il échoue/expire, et
 * ne doit JAMAIS toucher Sale.status (une vente COMPLETED est immuable, §17 règle 7 ; une
 * vente PENDING n'est pas non plus concernée par ce flux de paiement). Toute l'attente est
 * portée par le modèle séparé OnlinePaymentIntent, jamais par Sale.
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - L'ownership de la vente est vérifiée avant toute écriture (mirror
 *    PaymentSaleService.loadSaleForWrite, dupliqué ici : ces deux services n'ont pas à
 *    partager une base commune pour un simple contrôle d'ownership).
 *  - Un paiement en ligne ne peut jamais faire dépasser le solde restant de la vente
 *    (grandTotal − paidAmount) — même règle que PaymentSaleService.
 *  - confirmPayment()/expirePayment() sont des no-op idempotents (jamais d'exception non
 *    catchée) : ce sont des points d'entrée appelés par un webhook ou un job d'expiration,
 *    qui ne doivent jamais faire échouer leur appelant sur un cas normal de compétition
 *    (webhook vs expiration, double livraison webhook, etc.).
 */
@Injectable()
export class SaleOnlinePaymentService {
  private readonly logger = new Logger(SaleOnlinePaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly paymentSaleService: PaymentSaleService,
    private readonly asyncPaymentService: AsyncPaymentService,
    @InjectQueue('sale-online-payment-expiration')
    private readonly expirationQueue: Queue<SaleOnlinePaymentExpirationJobPayload>,
  ) {}

  /**
   * Initie un paiement en ligne sur une vente : vérifie l'ownership et le solde restant,
   * crée l'`OnlinePaymentIntent` (PENDING), puis — après la création, hors de toute
   * transaction, car il s'agit d'un appel réseau à séparer du commit (même règle que
   * PosService.createSale, S22) — génère le lien de paiement hébergé par l'agrégateur et
   * enfile le job d'expiration différé.
   *
   * @param organizationId Tenant courant (extrait du token, anti-IDOR).
   * @param saleId UUID de la vente à créditer.
   * @param amount Montant demandé — string décimale, jamais Float (§17 point A).
   * @throws NotFoundException si la vente est introuvable ou soft-deleted.
   * @throws ForbiddenException si la vente n'appartient pas à l'organisation.
   * @throws BadRequestException si le montant dépasse le solde restant de la vente.
   */
  async initiate(
    organizationId: string,
    saleId: string,
    amount: string,
  ): Promise<InitiateOnlinePaymentResult> {
    const sale = await this.loadSaleForWrite(saleId, organizationId);

    const amountDec = new Decimal(amount);
    const remaining = sale.grandTotal.minus(sale.paidAmount);
    if (amountDec.greaterThan(remaining)) {
      throw new BadRequestException(
        `Le montant dépasse le solde restant (${remaining.toFixed(3)}).`,
      );
    }

    const timeoutMs = Number(
      this.config.get<string>('SALE_ONLINE_PAYMENT_TIMEOUT_MS') ??
        DEFAULT_SALE_ONLINE_PAYMENT_TIMEOUT_MS,
    );

    const intent = await this.prisma.onlinePaymentIntent.create({
      data: {
        organizationId,
        saleId,
        amount: amountDec,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + timeoutMs),
      },
      select: { id: true, expiresAt: true },
    });

    const paymentLink = await this.asyncPaymentService.generatePaymentLinkFor(organizationId, {
      amount: amountDec,
      currency: 'XAF',
      reference: intent.id,
      callbackPath: organizationId,
    });

    await this.expirationQueue.add(
      'sale.expireOnlinePayment',
      { intentId: intent.id, organizationId },
      { delay: timeoutMs },
    );

    return { intentId: intent.id, paymentLink, expiresAt: intent.expiresAt };
  }

  /**
   * Confirme le paiement d'une intention en ligne (appelée par le futur contrôleur webhook
   * généralisé, idempotent via WebhookEvent en amont). Crée le `PaymentSale` correspondant
   * et le `PaymentWithCreditCard` associé, puis passe l'intention PENDING → CONFIRMED.
   *
   * No-op idempotent (jamais d'exception non catchée, jamais de log bloquant) si
   * l'intention est introuvable, hors organisation, ou déjà résolue (`status !== 'PENDING'`
   * — déjà confirmée ou déjà expirée : cas normal de compétition webhook/expiration). Un
   * webhook ne doit jamais faire échouer sa réponse HTTP.
   *
   * @param organizationId Tenant courant (extrait du contexte webhook résolu).
   * @param intentId UUID de l'`OnlinePaymentIntent` concernée.
   * @param confirmation Détails rapportés par l'agrégateur (provider, identifiants).
   */
  async confirmPayment(
    organizationId: string,
    intentId: string,
    confirmation: AggregatorPaymentConfirmation,
  ): Promise<void> {
    let resolvedSaleId: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      const intent = await tx.onlinePaymentIntent.findUnique({
        where: { id: intentId },
        select: { id: true, organizationId: true, saleId: true, amount: true, status: true },
      });

      if (!intent || intent.organizationId !== organizationId) {
        this.logger.warn(
          `confirmPayment : intention ${intentId} introuvable ou hors organisation — no-op`,
        );
        return;
      }
      if (intent.status !== 'PENDING') {
        this.logger.log(
          `confirmPayment : intention ${intentId} déjà ${intent.status} — no-op idempotent`,
        );
        return;
      }

      const sale = await tx.sale.findUnique({
        where: { id: intent.saleId },
        select: { userId: true, clientId: true },
      });
      if (!sale) {
        // Ne devrait jamais arriver (FK saleId non nullable) — garde défensive.
        this.logger.error(
          `confirmPayment : vente ${intent.saleId} introuvable pour l'intention ${intentId} — réconciliation manuelle requise`,
        );
        return;
      }

      let created: PaymentSaleResponse;
      try {
        created = await this.paymentSaleService.createInTransaction(
          tx,
          organizationId,
          sale.userId,
          intent.saleId,
          {
            date: new Date().toISOString(),
            amount: intent.amount.toString(),
            method: mapProviderToPaymentMethod(confirmation.provider),
            change: '0',
          },
        );
      } catch (err: unknown) {
        if (err instanceof BadRequestException) {
          // Solde dépassé — ex. remboursement concurrent entre initiation et confirmation.
          // On ne crée rien et on ne casse jamais la réponse HTTP au webhook : cas exceptionnel
          // journalisé explicitement pour intervention humaine.
          this.logger.error(
            `confirmPayment : solde dépassé pour l'intention ${intentId} (vente ${intent.saleId}) — réconciliation manuelle requise`,
            err,
          );
          return;
        }
        throw err;
      }

      await tx.paymentWithCreditCard.create({
        data: {
          paymentSaleId: created.id,
          organizationId,
          customerId: sale.clientId,
          provider: confirmation.provider,
          providerCustomerId: confirmation.providerCustomerId,
          providerTransactionId: confirmation.providerTransactionId,
        },
      });

      await tx.onlinePaymentIntent.update({
        where: { id: intentId },
        data: { status: 'CONFIRMED', paymentSaleId: created.id },
      });

      resolvedSaleId = intent.saleId;
    });

    if (resolvedSaleId) {
      this.realtimeGateway.server
        .to(`org:${organizationId}`)
        .emit('sale:updated', { saleId: resolvedSaleId });
    }
  }

  /**
   * Expire une intention de paiement en ligne restée PENDING au-delà de son délai (appelée
   * par SaleOnlinePaymentExpirationWorker). Passe uniquement `OnlinePaymentIntent.status` à
   * EXPIRED — **AUCUN** autre effet de bord.
   *
   * Contrairement à l'expiration POS (SaleService.expireAwaitingPayment(), qui repasse la
   * vente à CANCELLED et restitue le stock réservé à la création), cette méthode ne touche jamais
   * `Sale` ni le stock : décision de conception actée pour la vente classique (S31) — le
   * stock est décrémenté à validate() (S21), totalement découplé de l'encaissement, donc
   * un paiement en ligne différé n'a rien à restituer s'il expire, et une vente COMPLETED
   * est immuable (§17 règle 7) tandis qu'une vente PENDING n'est de toute façon pas
   * concernée par ce flux de paiement.
   *
   * No-op idempotent si l'intention est introuvable, hors organisation, ou déjà résolue
   * (`status !== 'PENDING'`).
   *
   * @param organizationId Tenant courant.
   * @param intentId UUID de l'`OnlinePaymentIntent` à expirer.
   */
  async expirePayment(organizationId: string, intentId: string): Promise<void> {
    const intent = await this.prisma.onlinePaymentIntent.findUnique({
      where: { id: intentId },
      select: { organizationId: true, status: true },
    });

    if (!intent || intent.organizationId !== organizationId) {
      this.logger.warn(
        `expirePayment : intention ${intentId} introuvable ou hors organisation — no-op`,
      );
      return;
    }
    if (intent.status !== 'PENDING') {
      this.logger.log(
        `expirePayment : intention ${intentId} déjà ${intent.status} — no-op idempotent`,
      );
      return;
    }

    await this.prisma.onlinePaymentIntent.update({
      where: { id: intentId },
      data: { status: 'EXPIRED' },
    });

    this.logger.log(
      `Intention de paiement en ligne ${intentId} expirée (org ${organizationId}) — aucun effet de bord sur Sale/stock`,
    );
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Charge la vente et vérifie son ownership (anti-IDOR). Mirror de
   * PaymentSaleService.loadSaleForWrite — dupliqué volontairement (cf. JSDoc de classe).
   */
  private async loadSaleForWrite(
    saleId: string,
    organizationId: string,
  ): Promise<{ grandTotal: Decimal; paidAmount: Decimal }> {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      select: { organizationId: true, deletedAt: true, grandTotal: true, paidAmount: true },
    });

    if (!sale || sale.deletedAt !== null) {
      throw new NotFoundException('Vente introuvable.');
    }
    if (sale.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return sale;
  }
}
