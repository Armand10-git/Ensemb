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
 * `isActive === false`) ET que l'environnement n'est PAS `production`, on bascule en mode
 * test. Cette dernière condition est impérative (revue sécurité S31) : contrairement à
 * `PaymentAggregatorService.isTestMode` (identifiants PLATEFORME, contrôlés par l'exploitant
 * via des variables d'environnement — §17 « environnement de confiance »), l'absence de
 * `PaymentGatewayCredential` est un état accessible en libre-service par CHAQUE organisation
 * (`PUT /organizations/settings/payment-gateway`, permission `organization.settings.edit`) —
 * c'est l'état PAR DÉFAUT de toute organisation qui n'a pas encore configuré son agrégateur.
 * Sans la garde `NODE_ENV`, `verifyWebhookSignature` accepterait TOUJOURS n'importe quelle
 * signature (ou son absence) pour ces organisations, permettant à n'importe quel appelant du
 * webhook public de confirmer un paiement CARD/MOBILE_MONEY jamais réellement effectué — un
 * contournement complet de paiement, pas une simple facilité de développement. En production,
 * l'absence de credential actif fait donc échouer la vérification de signature (webhook
 * rejeté) et la génération de lien (exception), plutôt que de les court-circuiter.
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
   *   si l'organisation n'a pas (ou plus) de compte agrégateur actif ET que l'environnement
   *   n'est pas `production` (mode test — voir JSDoc de classe).
   * @throws Error si l'organisation n'a pas de compte agrégateur actif EN PRODUCTION — jamais de
   *   lien fictif silencieux dans cet environnement.
   */
  async generatePaymentLink(
    organizationId: string,
    params: TenantPaymentLinkParams,
  ): Promise<string> {
    const credential = await this.credentialService.getDecryptedCredential(organizationId);

    if (!credential) {
      if (!this.isPlatformTestMode()) {
        throw new Error(
          `Organisation ${organizationId} : aucun agrégateur de paiement actif configuré.`,
        );
      }
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
   * En mode test (organisation sans agrégateur actif ET environnement non-production),
   * retourne toujours `true`. EN PRODUCTION, une organisation sans agrégateur actif ne peut
   * jamais avoir de webhook valide : retourne `false` (voir JSDoc de classe — sans cette
   * garde, n'importe qui pourrait confirmer un paiement jamais effectué pour toute
   * organisation n'ayant pas configuré son agrégateur, l'état par défaut).
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
      if (this.isPlatformTestMode()) {
        return true;
      }
      this.logger.warn(
        `Organisation ${organizationId} sans agrégateur de paiement actif — webhook rejeté (production)`,
      );
      return false;
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

  /**
   * `true` hors production — c'est la seule condition qui autorise le mode test (lien fictif,
   * signature toujours acceptée) pour une organisation sans agrégateur actif. Contrôlée par
   * `NODE_ENV`, une variable d'environnement de confiance posée par l'exploitant (jamais par
   * un tenant) — voir JSDoc de classe pour le raisonnement de sécurité complet.
   */
  private isPlatformTestMode(): boolean {
    return this.config.get<string>('NODE_ENV') !== 'production';
  }
}
