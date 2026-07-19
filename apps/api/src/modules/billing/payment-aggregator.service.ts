import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import type { Decimal } from '@prisma/client/runtime/library';

export interface PaymentLinkParams {
  amount: Decimal;
  currency: string;
  reference: string;
  callbackUrl: string;
}

/**
 * Wrapper mince autour de l'API de l'agrégateur de paiement.
 * En mode test (NODE_ENV=test ou variables absentes) : stub sans appel HTTP réel.
 * Clés lues depuis ConfigService : PAYMENT_AGGREGATOR_API_KEY, PAYMENT_AGGREGATOR_SITE_ID.
 */
@Injectable()
export class PaymentAggregatorService {
  private readonly logger = new Logger(PaymentAggregatorService.name);
  private readonly isTestMode: boolean;
  private readonly apiKey: string | undefined;
  private readonly siteId: string | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(private readonly config: ConfigService) {
    const nodeEnv = this.config.get<string>('NODE_ENV');
    this.apiKey = this.config.get<string>('PAYMENT_AGGREGATOR_API_KEY');
    this.siteId = this.config.get<string>('PAYMENT_AGGREGATOR_SITE_ID');
    this.webhookSecret = this.config.get<string>('PAYMENT_AGGREGATOR_WEBHOOK_SECRET');

    this.isTestMode = nodeEnv === 'test' || !this.apiKey || !this.siteId;

    if (this.isTestMode) {
      this.logger.log('PaymentAggregatorService en mode test — aucun appel HTTP réel');
    }
  }

  /**
   * Génère un lien de paiement via l'agrégateur.
   * En mode test, retourne un lien fictif sans appel réseau.
   */
  async generatePaymentLink(params: PaymentLinkParams): Promise<string> {
    if (this.isTestMode) {
      return `https://pay.test/mock-${randomUUID()}`;
    }

    // Appel réel à l'agrégateur (ex. CinetPay, Monetbil…)
    // La réponse est une URL de paiement hébergée par l'agrégateur.
    const response = await fetch('https://api.aggregateur.example/payment/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        site_id: this.siteId,
        transaction_id: params.reference,
        amount: params.amount.toNumber(),
        currency: params.currency,
        notify_url: params.callbackUrl,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Erreur agrégateur ${response.status}: ${body}`);
      throw new Error(`L'agrégateur de paiement a refusé la demande (${response.status}).`);
    }

    const data = (await response.json()) as { payment_url: string };
    return data.payment_url;
  }

  /**
   * Vérifie la signature HMAC-SHA256 d'un webhook entrant.
   * Le corps brut (Buffer) et la signature fournie par l'agrégateur dans le header sont comparés.
   * En mode test, toujours vrai.
   *
   * @param payload - Corps brut de la requête (avant parsing JSON)
   * @param signature - Valeur du header X-Aggregator-Signature
   */
  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    if (this.isTestMode) return true;

    if (!this.webhookSecret) {
      this.logger.error('PAYMENT_AGGREGATOR_WEBHOOK_SECRET absent — signature non vérifiable');
      return false;
    }

    try {
      const expected = createHmac('sha256', this.webhookSecret)
        .update(payload)
        .digest('hex');

      const expectedBuf = Buffer.from(expected, 'utf8');
      const signatureBuf = Buffer.from(signature, 'utf8');

      if (expectedBuf.length !== signatureBuf.length) return false;
      return timingSafeEqual(expectedBuf, signatureBuf);
    } catch (err) {
      this.logger.error('Erreur lors de la vérification HMAC', err);
      return false;
    }
  }
}
