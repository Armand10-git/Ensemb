import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../common/prisma.service';
import { TenantPaymentGatewayService } from './tenant-payment-gateway.service';

/** Paramètres de génération d'un lien de paiement asynchrone pour un flux de vente donné. */
export interface AsyncPaymentLinkParams {
  amount: Decimal;
  currency: string;
  reference: string;
  /** Segment ajouté après la base de callback (ex. organizationId pour la route webhook POS actuelle). */
  callbackPath: string;
}

/** Paramètres de persistance idempotente d'un événement webhook entrant. */
export interface PersistWebhookEventParams {
  provider: string;
  providerEventId: string;
  payload: object;
  organizationId: string | null;
  saleId?: string;
  /** Réservé à la vente classique (S31) : intention de paiement en ligne concernée. */
  onlinePaymentIntentId?: string;
}

/**
 * Flux partagé de paiement asynchrone (mobile money / carte via l'agrégateur) — extrait de
 * `PosService`/`PosWebhookController` (S22) pour être réutilisé tel quel par la vente classique
 * (S31) plutôt que dupliqué une deuxième fois. Généralise :
 * 1. La génération du lien de paiement (construction de l'URL de callback + délégation à
 *    `TenantPaymentGatewayService`).
 * 2. La persistance idempotente du `WebhookEvent` (garde d'unicité `(provider, providerEventId)`).
 * 3. Le marquage best-effort du `WebhookEvent` comme traité.
 */
@Injectable()
export class AsyncPaymentService {
  private readonly logger = new Logger(AsyncPaymentService.name);

  constructor(
    private readonly gateway: TenantPaymentGatewayService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Construit l'URL de callback (base configurable + segment spécifique au flux appelant) et
   * délègue la génération du lien à `TenantPaymentGatewayService.generatePaymentLink`.
   *
   * Réutilise la variable d'env `POS_PAYMENT_CALLBACK_BASE_URL` existante pour les deux flux
   * (POS et vente classique) plutôt que d'introduire une deuxième variable : les deux flux
   * pointent vers le même hôte/route de webhooks paiement, seul le segment de chemin
   * (`callbackPath`) distingue POS d'une vente classique.
   *
   * @param organizationId Tenant dont le compte agrégateur doit être utilisé.
   * @param params Montant (Decimal), devise, référence (UUID de vente/intention de paiement) et
   *   segment de chemin de callback.
   * @returns URL de paiement hébergée par l'agrégateur (ou lien fictif en mode test).
   */
  async generatePaymentLinkFor(
    organizationId: string,
    params: AsyncPaymentLinkParams,
  ): Promise<string> {
    const base =
      this.config.get<string>('POS_PAYMENT_CALLBACK_BASE_URL') ??
      'http://localhost:3000/api/v1/webhooks/payments';
    const callbackUrl = `${base}/${params.callbackPath}`;

    return this.gateway.generatePaymentLink(organizationId, {
      amount: params.amount,
      currency: params.currency,
      reference: params.reference,
      callbackUrl,
    });
  }

  /**
   * Persiste un `WebhookEvent` avant tout traitement métier — garde d'idempotence via la
   * contrainte unique `(provider, providerEventId)`. Mirror exact de la méthode privée
   * `persistWebhookEvent` de `PosWebhookController` (S22), généralisée pour être appelée par
   * plusieurs flux (POS, vente classique).
   *
   * @param params provider/providerEventId (clé d'idempotence), payload brut, organizationId
   *   (peut être `null` si non résolvable avant persistance), saleId (POS) et/ou
   *   onlinePaymentIntentId (vente classique) optionnels — mutuellement exclusifs selon le flux
   *   appelant.
   * @returns L'id du `WebhookEvent` créé, ou `null` en cas de doublon (P2002) ou de toute autre
   *   erreur DB (l'appelant répond alors 200 sans traiter, pour ne pas déclencher de retry
   *   infini côté agrégateur).
   */
  async persistWebhookEvent(params: PersistWebhookEventParams): Promise<string | null> {
    try {
      const evt = await this.prisma.webhookEvent.create({
        data: {
          provider: params.provider,
          providerEventId: params.providerEventId,
          payload: params.payload,
          saleId: params.saleId ?? null,
          onlinePaymentIntentId: params.onlinePaymentIntentId ?? null,
          organizationId: params.organizationId,
        },
        select: { id: true },
      });
      return evt.id;
    } catch (err: unknown) {
      if (this.isPrismaUniqueViolation(err)) {
        this.logger.warn(
          `Webhook ${params.provider}/${params.providerEventId} déjà traité — ignoré (doublon)`,
        );
        return null;
      }
      // Erreur DB hors-P2002 : l'événement est perdu — l'appelant répond 200 pour ne pas
      // déclencher un retry infini de l'agrégateur (spec §17 point V).
      this.logger.error(
        `Erreur persistence WebhookEvent ${params.provider}/${params.providerEventId}`,
        err,
      );
      return null;
    }
  }

  /**
   * Marque le `WebhookEvent` comme traité — best-effort, ne bloque et ne fait jamais échouer
   * l'appelant : toute erreur est journalisée puis avalée. Mirror exact de `markProcessed` de
   * `PosWebhookController` (S22).
   *
   * @param webhookEventId Id du `WebhookEvent` précédemment persisté par `persistWebhookEvent`.
   */
  async markProcessed(webhookEventId: string): Promise<void> {
    try {
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: new Date() },
      });
    } catch (err: unknown) {
      this.logger.error(`Impossible de mettre à jour processedAt pour ${webhookEventId}`, err);
    }
  }

  /** Détecte une violation de contrainte unique Prisma (P2002) sans dépendre du type d'erreur Prisma exact. */
  private isPrismaUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    );
  }
}
