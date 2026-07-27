import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentAggregatorService } from './payment-aggregator.service';
import { BillingService } from './billing.service';
import { PrismaService } from '../../common/prisma.service';

interface WebhookPayload {
  type: string;
  provider: string;
  providerEventId: string;
  invoiceId?: string;
  [key: string]: unknown;
}

/**
 * Endpoint public pour le webhook de facturation SaaS (abonnement plateforme).
 * Le webhook mobile money POS vit dans PosModule (pos-webhook.controller.ts, S22) —
 * les deux comptes agrégateur (plateforme vs tenant, §17 point M) ne doivent jamais
 * partager de code au-delà de PaymentAggregatorService/verifyWebhookSignature.
 *
 * Sécurité (§17 point V) :
 * 1. Corps lu en Buffer brut pour la vérification HMAC — NestJS démarré avec rawBody: true
 * 2. Signature vérifiée AVANT tout accès à la base
 * 3. WebhookEvent persisté avec contrainte unique (provider, providerEventId) avant traitement
 * 4. Réponse 200 systématique même en cas d'erreur interne (évite les retries de l'agrégateur)
 */
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly aggregator: PaymentAggregatorService,
    private readonly billingService: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /api/v1/webhooks/billing
   * Route publique — pas de JwtAuthGuard. Protégée par signature HMAC.
   */
  @Post('billing')
  @HttpCode(HttpStatus.OK)
  async handleBillingWebhook(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true }> {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      this.logger.warn('Webhook reçu sans corps brut — rawBody absent');
      throw new UnauthorizedException('Corps de requête absent.');
    }

    const signature = (req.headers['x-aggregator-signature'] as string) ?? '';
    if (!this.aggregator.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Webhook rejeté : signature HMAC invalide');
      throw new UnauthorizedException('Signature invalide.');
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
    } catch (err) {
      this.logger.error('Webhook billing : JSON invalide après vérification HMAC', err);
      return { received: true };
    }

    const { type, provider, providerEventId } = payload;
    if (!provider || !providerEventId) {
      this.logger.warn('Webhook billing sans provider ou providerEventId — ignoré');
      return { received: true };
    }

    // Résolution de l'organizationId via l'invoiceId (scope tenant sur le WebhookEvent)
    let organizationId: string | null = null;
    if (payload.invoiceId) {
      const inv = await this.prisma.invoice.findUnique({
        where: { id: payload.invoiceId },
        select: { organizationId: true },
      });
      organizationId = inv?.organizationId ?? null;
    }

    // Garde d'idempotence — insert atomique avant tout traitement métier
    const webhookEventId = await this.persistWebhookEvent(provider, providerEventId, payload, organizationId, payload.invoiceId);
    if (webhookEventId === null) return { received: true }; // doublon ou erreur

    // Traitement métier
    if (type === 'payment.success') {
      const invoiceId = payload.invoiceId;
      if (!invoiceId) {
        this.logger.warn(`Webhook billing payment.success sans invoiceId — ${providerEventId}`);
        return { received: true };
      }
      try {
        await this.billingService.confirmPayment(invoiceId);
        this.logger.log(`Paiement billing confirmé — Invoice ${invoiceId}`);
      } catch (err) {
        this.logger.error(`Erreur confirmation paiement Invoice ${invoiceId}`, err);
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
    invoiceId?: string,
  ): Promise<string | null> {
    try {
      const evt = await this.prisma.webhookEvent.create({
        data: {
          provider,
          providerEventId,
          payload,
          invoiceId: invoiceId ?? null,
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
      // un retry infini de l'agrégateur (spec §17 point V). Dette : ajouter un compteur
      // payment_webhook_lost_total (Prometheus) pour alerter sur des pertes en rafale (T08+).
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
