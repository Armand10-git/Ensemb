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
 * Endpoint public pour les webhooks de l'agrégateur de paiement.
 *
 * Sécurité (§17 point V) :
 * 1. Corps lu en Buffer brut pour la vérification HMAC — NestJS doit être démarré avec rawBody: true
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
    // 1. Vérification de la signature HMAC avant tout traitement (§17 point V)
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

    // 2. Parsing du payload JSON (déjà validé par la signature)
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
    } catch (err) {
      this.logger.error('Webhook : JSON invalide après vérification HMAC', err);
      // On répond 200 pour ne pas déclencher un retry inutile
      return { received: true };
    }

    const { type, provider, providerEventId } = payload;

    if (!provider || !providerEventId) {
      this.logger.warn('Webhook sans provider ou providerEventId — ignoré');
      return { received: true };
    }

    // 3. Persistance du WebhookEvent avec contrainte d'unicité — garde d'idempotence
    let isNew = false;
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider,
          providerEventId,
          payload: payload as object,
          invoiceId: payload.invoiceId ?? null,
        },
      });
      isNew = true;
    } catch (err: unknown) {
      // P2002 = violation de contrainte unique → événement déjà traité
      if (this.isPrismaUniqueViolation(err)) {
        this.logger.warn(`Webhook ${provider}/${providerEventId} déjà traité — ignoré`);
        return { received: true };
      }
      this.logger.error(`Erreur lors de la persistance du WebhookEvent ${provider}/${providerEventId}`, err);
      // On répond 200 même en cas d'erreur interne (pas de retry agrégateur)
      return { received: true };
    }

    // 4. Traitement métier — uniquement si l'événement est nouveau
    if (isNew && type === 'payment.success') {
      const invoiceId = payload.invoiceId;
      if (!invoiceId) {
        this.logger.warn(`Webhook payment.success sans invoiceId — ${providerEventId}`);
        return { received: true };
      }

      try {
        await this.billingService.confirmPayment(invoiceId);
        this.logger.log(`Paiement confirmé pour Invoice ${invoiceId}`);
      } catch (err) {
        // Erreur loggée côté serveur — on ne l'expose pas et on ne déclenche pas de retry
        this.logger.error(`Erreur lors de la confirmation du paiement Invoice ${invoiceId}`, err);
      }
    }

    return { received: true };
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
