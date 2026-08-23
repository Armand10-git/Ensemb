import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { Decimal } from '@prisma/client/runtime/library';
import { PaymentGatewayCredentialService } from './payment-gateway-credential.service';

/** Paramètres de génération d'un lien de paiement pour une organisation donnée. */
export interface TenantPaymentLinkParams {
  amount: Decimal;
  currency: string;
  reference: string;
  callbackUrl: string;
}

/**
 * Agrégateur de paiement PAR ORGANISATION (S31, §17 point S) : même patron d'appel HTTP/HMAC
 * que `PaymentAggregatorService` (billing, credentials plateforme), mais les identifiants
 * (apiKey, merchantId, webhookSecret) sont résolus par tenant via
 * `PaymentGatewayCredentialService.getDecryptedCredential`.
 *
 * Un seul compte agrégateur par organisation : le provider réel (CARD/Orange Money/MTN MoMo)
 * n'est connu qu'au retour du webhook — cette classe ne fait aucune sélection de provider à
 * l'écriture, elle ne fait que router vers le compte marchand du tenant.
 *
 * Mode test : si `getDecryptedCredential` retourne `null` (aucune configuration OU
 * `isActive === false`), on bascule en mode test — jamais d'exception — mirror exact du
 * comportement de `PaymentAggregatorService.isTestMode`.
 */
@Injectable()
export class TenantPaymentGatewayService {
  private readonly logger = new Logger(TenantPaymentGatewayService.name);

  constructor(
    private readonly credentialService: PaymentGatewayCredentialService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Génère un lien de paiement hébergé par l'agrégateur pour le compte marchand de
   * l'organisation.
   *
   * @param organizationId Tenant dont le compte agrégateur doit être utilisé.
   * @param params Montant (Decimal — jamais Float), devise, référence (ex. UUID de vente/facture)
   *   et URL de callback à notifier par l'agrégateur.
   * @returns URL de paiement hébergée par l'agrégateur, ou un lien fictif `https://pay.test/mock-*`
   *   si l'organisation n'a pas (ou plus) de compte agrégateur actif (mode test).
   */
  async generatePaymentLink(
    organizationId: string,
    params: TenantPaymentLinkParams,
  ): Promise<string> {
    const credential = await this.credentialService.getDecryptedCredential(organizationId);

    if (!credential) {
      this.logger.log(
        `Organisation ${organizationId} sans agrégateur de paiement actif — mode test, lien fictif généré`,
      );
      return `https://pay.test/mock-${randomUUID()}`;
    }

    // Même URL de base d'agrégateur que PaymentAggregatorService (infrastructure tierce
    // partagée, ex. CinetPay/Monetbil) — seuls apiKey/merchantId diffèrent par tenant, donc on
    // réutilise la variable d'env PAYMENT_AGGREGATOR_BASE_URL plutôt que d'en créer une seconde.
    const baseUrl =
      this.config.get<string>('PAYMENT_AGGREGATOR_BASE_URL') ?? 'https://api.cinetpay.com/v2';

    const response = await fetch(`${baseUrl}/payment/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.apiKey}`,
      },
      body: JSON.stringify({
        site_id: credential.merchantId,
        transaction_id: params.reference,
        // Montant en string pour préserver la précision Decimal (jamais Float)
        amount: params.amount.toString(),
        currency: params.currency,
        notify_url: params.callbackUrl,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(
        `Erreur agrégateur (org ${organizationId}) ${response.status}: ${body}`,
      );
      throw new Error(`L'agrégateur de paiement a refusé la demande (${response.status}).`);
    }

    const data = (await response.json()) as { payment_url: string };
    return data.payment_url;
  }

  /**
   * Vérifie la signature HMAC-SHA256 d'un webhook entrant en utilisant le `webhookSecret`
   * déchiffré propre à CETTE organisation — c'est le cœur de l'isolation tenant du webhook :
   * une organisation A ne doit jamais pouvoir valider une signature avec le secret d'une
   * organisation B, et réciproquement.
   *
   * En mode test (organisation sans agrégateur actif), retourne toujours `true`, mirror exact
   * de `PaymentAggregatorService.verifyWebhookSignature`.
   *
   * @param organizationId Tenant propriétaire du webhook (jamais déduit du payload — fourni par
   *   la route, ex. `:organizationId` du callback).
   * @param payload Corps brut de la requête (avant parsing JSON).
   * @param signature Valeur du header de signature fourni par l'agrégateur.
   */
  async verifyWebhookSignature(
    organizationId: string,
    payload: Buffer,
    signature: string,
  ): Promise<boolean> {
    const credential = await this.credentialService.getDecryptedCredential(organizationId);

    if (!credential) {
      return true;
    }

    try {
      const expected = createHmac('sha256', credential.webhookSecret)
        .update(payload)
        .digest('hex');

      const expectedBuf = Buffer.from(expected, 'utf8');
      const signatureBuf = Buffer.from(signature, 'utf8');

      if (expectedBuf.length !== signatureBuf.length) return false;
      return timingSafeEqual(expectedBuf, signatureBuf);
    } catch (err) {
      this.logger.error(`Erreur lors de la vérification HMAC — org ${organizationId}`, err);
      return false;
    }
  }
}
