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
import { PaymentAggregatorService } from '../billing/payment-aggregator.service';
import { PrismaService } from '../../common/prisma.service';
import { PosService } from './pos.service';

interface PosWebhookPayload {
  type: string;
  providerEventId: string;
  /** UUID de la vente POS — échoté par l'agrégateur, transmis tel quel dans generatePaymentLink (S22). */
  saleId?: string;
  [key: string]: unknown;
}

/**
 * Webhook mobile money POS (S22, §18.2 étape 10 ; §17 point V).
 *
 * Vit dans PosModule (et non BillingModule) : le compte agrégateur du tenant (encaisse ses
 * propres clients) est distinct du compte de facturation SaaS de la plateforme (§17 point M) —
 * séparer les deux contrôleurs élimine tout risque de confusion entre les deux flux et évite
 * une dépendance croisée BillingModule ↔ PosModule (PosModule importe BillingModule pour
 * PaymentAggregatorService, jamais l'inverse).
 *
 * Sécurité (§17 point V) — même patron que WebhookController (billing) :
 * 1. Corps lu en Buffer brut pour la vérification HMAC — NestJS démarré avec rawBody: true
 * 2. Signature vérifiée AVANT tout accès à la base
 * 3. WebhookEvent persisté avec contrainte unique (provider, providerEventId) avant traitement
 * 4. Réponse 200 systématique même en cas d'erreur interne (évite les retries de l'agrégateur)
 */
@Controller('webhooks')
export class PosWebhookController {
  private readonly logger = new Logger(PosWebhookController.name);

  constructor(
    private readonly aggregator: PaymentAggregatorService,
    private readonly prisma: PrismaService,
    private readonly posService: PosService,
  ) {}

  /**
   * POST /api/v1/webhooks/payments/:organizationId
   * Confirme une vente AWAITING_PAYMENT → COMPLETED via PosService.confirmMobileMoneyPayment.
   * Route publique — protégée par signature HMAC, idempotente via WebhookEvent (unicité
   * provider+providerEventId).
   */
  @Post('payments/:organizationId')
  @HttpCode(HttpStatus.OK)
  async handlePosPaymentWebhook(
    @Param('organizationId') organizationId: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true }> {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      this.logger.warn(`Webhook POS [org ${organizationId}] reçu sans corps brut`);
      throw new UnauthorizedException('Corps de requête absent.');
    }

    const signature = (req.headers['x-aggregator-signature'] as string) ?? '';
    if (!this.aggregator.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn(`Webhook POS [org ${organizationId}] rejeté : signature HMAC invalide`);
      throw new UnauthorizedException('Signature invalide.');
    }

    let payload: PosWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as PosWebhookPayload;
    } catch (err) {
      this.logger.error(`Webhook POS [org ${organizationId}] : JSON invalide`, err);
      return { received: true };
    }

    const { type, providerEventId, saleId } = payload;
    const provider = 'pos-aggregator';

    if (!providerEventId) {
      this.logger.warn(`Webhook POS [org ${organizationId}] sans providerEventId — ignoré`);
      return { received: true };
    }

    // Vérification que l'organisation existe (§17 — tout accès vérifie organizationId côté serveur)
    const orgExists = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!orgExists) {
      this.logger.warn(`Webhook POS — organizationId inconnu : ${organizationId}`);
      // 200 pour ne pas révéler à l'agrégateur si l'org existe (même pattern que les autres erreurs)
      return { received: true };
    }

    // Garde d'idempotence — clé composite (provider, providerEventId)
    const webhookEventId = await this.persistWebhookEvent(provider, providerEventId, payload, organizationId, saleId);
    if (webhookEventId === null) return { received: true };

    if (type === 'payment.success') {
      if (!saleId) {
        this.logger.warn(`Webhook POS [org ${organizationId}] payment.success sans saleId — ignoré`);
      } else {
        try {
          await this.posService.confirmMobileMoneyPayment(organizationId, saleId);
          this.logger.log(`Paiement POS confirmé — vente ${saleId}, org ${organizationId}`);
        } catch (err) {
          this.logger.error(`Erreur confirmation paiement POS — vente ${saleId}`, err);
        }
      }
    }

    this.markProcessed(webhookEventId);
    return { received: true };
  }

  /**
   * Persiste le WebhookEvent avant tout traitement.
   * @returns l'id du WebhookEvent créé, ou null si doublon/erreur.
   */
  private async persistWebhookEvent(
    provider: string,
    providerEventId: string,
    payload: object,
    organizationId: string | null,
    saleId?: string,
  ): Promise<string | null> {
    try {
      const evt = await this.prisma.webhookEvent.create({
        data: {
          provider,
          providerEventId,
          payload,
          saleId: saleId ?? null,
          organizationId,
        },
        select: { id: true },
      });
      return evt.id;
    } catch (err: unknown) {
      if (this.isPrismaUniqueViolation(err)) {
        this.logger.warn(`Webhook ${provider}/${providerEventId} déjà traité — ignoré (doublon)`);
        return null;
      }
      // Erreur DB hors-P2002 : l'événement est perdu — on répond 200 pour ne pas déclencher
      // un retry infini de l'agrégateur (spec §17 point V).
      this.logger.error(`Erreur persistence WebhookEvent ${provider}/${providerEventId}`, err);
      return null;
    }
  }

  /** Marque le WebhookEvent comme traité — best-effort, ne bloque pas la réponse. */
  private markProcessed(webhookEventId: string): void {
    this.prisma.webhookEvent
      .update({ where: { id: webhookEventId }, data: { processedAt: new Date() } })
      .catch((err: unknown) =>
        this.logger.error(`Impossible de mettre à jour processedAt pour ${webhookEventId}`, err),
      );
  }

  private isPrismaUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    );
  }
}
