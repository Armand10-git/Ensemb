import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentProvider } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { PosService } from '../pos/pos.service';
import { SaleOnlinePaymentService } from '../sales/sale-online-payment.service';
import { TenantPaymentGatewayService } from './tenant-payment-gateway.service';
import { AsyncPaymentService } from './async-payment.service';
import type { AggregatorPaymentConfirmation } from './payment-provider.util';

const KNOWN_PROVIDERS: readonly PaymentProvider[] = ['CARD', 'ORANGE_MONEY', 'MTN_MOMO'];

interface PaymentWebhookPayload {
  type: string;
  providerEventId: string;
  /** UUID de la vente POS — mutuellement exclusif avec intentId (S22, échoté par l'agrégateur). */
  saleId?: string;
  /** UUID de l'intention de paiement en ligne d'une vente classique (S31, échoté par l'agrégateur). */
  intentId?: string;
  /** Moyen réellement utilisé, rapporté par l'agrégateur à la confirmation (S31). */
  channel?: string;
  providerCustomerId?: string;
  providerTransactionId?: string;
  [key: string]: unknown;
}

/**
 * Webhook paiement — carte/mobile money, POS et vente classique (S22 puis généralisé S31,
 * §18.2 étape 10 ; §17 point V).
 *
 * Vit dans PaymentGatewayModule (et non PosModule/SalesModule) : point d'entrée unique qui
 * dépend à la fois de PosService (confirmAsyncPayment) et SaleOnlinePaymentService
 * (confirmPayment) sans créer de dépendance croisée PosModule ↔ SalesModule — les deux modules
 * métier restent indépendants l'un de l'autre, seul ce contrôleur les connaît tous les deux.
 *
 * Sécurité (§17 point V) :
 * 1. Corps lu en Buffer brut pour la vérification HMAC — NestJS démarré avec rawBody: true
 * 2. Signature vérifiée AVANT tout accès à la base, PAR ORGANISATION (TenantPaymentGatewayService
 *    résout le webhookSecret de CETTE organisation — un webhook ne peut jamais être validé avec
 *    le secret d'une autre organisation, cœur de l'isolation tenant du webhook)
 * 3. WebhookEvent persisté avec contrainte unique (provider, providerEventId) avant traitement
 * 4. Réponse 200 systématique même en cas d'erreur interne (évite les retries de l'agrégateur)
 *
 * Routage : le payload porte soit `saleId` (POS, résolu par PosService.confirmAsyncPayment) soit
 * `intentId` (vente classique, résolu par SaleOnlinePaymentService.confirmPayment) — jamais les
 * deux à la fois. `channel`/`providerCustomerId`/`providerTransactionId` sont requis pour
 * confirmer un paiement (nécessaires à PaymentWithCreditCard) ; absents, l'événement est persisté
 * (idempotence) mais aucune confirmation n'a lieu.
 */
@Controller('webhooks')
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(
    private readonly gateway: TenantPaymentGatewayService,
    private readonly asyncPayment: AsyncPaymentService,
    private readonly prisma: PrismaService,
    private readonly posService: PosService,
    private readonly saleOnlinePaymentService: SaleOnlinePaymentService,
  ) {}

  /**
   * POST /api/v1/webhooks/payments/:organizationId
   * Confirme un paiement asynchrone (POS AWAITING_PAYMENT → COMPLETED, ou vente classique
   * OnlinePaymentIntent PENDING → CONFIRMED). Route publique — protégée par signature HMAC
   * résolue par organisation, idempotente via WebhookEvent (unicité provider+providerEventId).
   */
  @Post('payments/:organizationId')
  @HttpCode(HttpStatus.OK)
  async handlePaymentWebhook(
    @Param('organizationId') organizationId: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true }> {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      this.logger.warn(`Webhook paiement [org ${organizationId}] reçu sans corps brut`);
      throw new UnauthorizedException('Corps de requête absent.');
    }

    const signature = (req.headers['x-aggregator-signature'] as string) ?? '';
    if (!(await this.gateway.verifyWebhookSignature(organizationId, rawBody, signature))) {
      this.logger.warn(`Webhook paiement [org ${organizationId}] rejeté : signature HMAC invalide`);
      throw new UnauthorizedException('Signature invalide.');
    }

    let payload: PaymentWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as PaymentWebhookPayload;
    } catch (err) {
      this.logger.error(`Webhook paiement [org ${organizationId}] : JSON invalide`, err);
      return { received: true };
    }

    const { type, providerEventId, saleId, intentId } = payload;
    const provider = 'payment-aggregator';

    if (!providerEventId) {
      this.logger.warn(`Webhook paiement [org ${organizationId}] sans providerEventId — ignoré`);
      return { received: true };
    }

    if (saleId && intentId) {
      this.logger.warn(
        `Webhook paiement [org ${organizationId}] : saleId et intentId fournis simultanément — ignoré (ambigu)`,
      );
      return { received: true };
    }

    // Vérification que l'organisation existe (§17 — tout accès vérifie organizationId côté serveur)
    const orgExists = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!orgExists) {
      this.logger.warn(`Webhook paiement — organizationId inconnu : ${organizationId}`);
      // 200 pour ne pas révéler à l'agrégateur si l'org existe (même pattern que les autres erreurs)
      return { received: true };
    }

    // Garde d'idempotence — clé composite (provider, providerEventId)
    const webhookEventId = await this.asyncPayment.persistWebhookEvent({
      provider,
      providerEventId,
      payload,
      organizationId,
      saleId,
      onlinePaymentIntentId: intentId,
    });
    if (webhookEventId === null) return { received: true };

    if (type === 'payment.success') {
      await this.dispatchConfirmation(organizationId, payload);
    }

    await this.asyncPayment.markProcessed(webhookEventId);
    return { received: true };
  }

  /**
   * Route la confirmation vers PosService ou SaleOnlinePaymentService selon le discriminant du
   * payload (saleId vs intentId). N'appelle jamais l'un des deux services si les champs
   * agrégateur (channel/providerCustomerId/providerTransactionId) sont incomplets — ces champs
   * sont indispensables à la création de PaymentWithCreditCard.
   */
  private async dispatchConfirmation(
    organizationId: string,
    payload: PaymentWebhookPayload,
  ): Promise<void> {
    const { saleId, intentId, channel, providerCustomerId, providerTransactionId } = payload;

    if (!channel || !providerCustomerId || !providerTransactionId) {
      this.logger.warn(
        `Webhook paiement [org ${organizationId}] payment.success incomplet ` +
          '(channel/providerCustomerId/providerTransactionId manquant) — ignoré',
      );
      return;
    }
    if (!this.isKnownProvider(channel)) {
      this.logger.warn(`Webhook paiement [org ${organizationId}] : channel inconnu "${channel}" — ignoré`);
      return;
    }

    const confirmation: AggregatorPaymentConfirmation = {
      provider: channel,
      providerCustomerId,
      providerTransactionId,
    };

    try {
      if (saleId) {
        await this.posService.confirmAsyncPayment(organizationId, saleId, confirmation);
        this.logger.log(`Paiement POS confirmé — vente ${saleId}, org ${organizationId}`);
      } else if (intentId) {
        await this.saleOnlinePaymentService.confirmPayment(organizationId, intentId, confirmation);
        this.logger.log(`Paiement en ligne confirmé — intention ${intentId}, org ${organizationId}`);
      } else {
        this.logger.warn(
          `Webhook paiement [org ${organizationId}] payment.success sans saleId ni intentId — ignoré`,
        );
      }
    } catch (err) {
      // Un webhook ne doit jamais faire échouer la réponse HTTP à l'agrégateur (§17 point V).
      this.logger.error(`Erreur confirmation paiement — org ${organizationId}`, err);
    }
  }

  private isKnownProvider(value: string): value is PaymentProvider {
    return (KNOWN_PROVIDERS as readonly string[]).includes(value);
  }
}
