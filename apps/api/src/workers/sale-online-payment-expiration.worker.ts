import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SaleOnlinePaymentService } from '../modules/sales/sale-online-payment.service';
import { AuditService } from '../modules/audit/audit.service';

export interface SaleOnlinePaymentExpirationJobData {
  intentId: string;
  organizationId: string;
}

/**
 * Worker BullMQ dédié à l'expiration des intentions de paiement en ligne sur les ventes
 * classiques (S31, §17 point V). Tourne dans le process worker dédié (§17 point Z), jamais
 * dans le process HTTP.
 *
 * Un seul job : `sale.expireOnlinePayment`, enfilé par SaleOnlinePaymentService.initiate
 * avec un délai SALE_ONLINE_PAYMENT_TIMEOUT_MS (défaut 15 min) à la création d'une intention.
 *
 * Structure identique à PosPaymentExpirationWorker (S22) — logs, gestion d'erreur — mais
 * PAS son contenu métier : contrairement au POS (qui appelle SaleService.expireAwaitingPayment()
 * et restitue le stock réservé), ce worker appelle uniquement
 * SaleOnlinePaymentService.expirePayment(), qui ne modifie JAMAIS Sale.status ni le stock
 * — décision de conception actée pour la vente classique (S31, cf. JSDoc de
 * SaleOnlinePaymentService.expirePayment). Aucun contexte HTTP dans un processor :
 * @Auditable (qui lit req.user) ne s'applique pas ici — l'audit est journalisé directement
 * via AuditService.create(actorType: 'SYSTEM', actorId: null).
 */
@Processor('sale-online-payment-expiration')
export class SaleOnlinePaymentExpirationWorker extends WorkerHost {
  private readonly logger = new Logger(SaleOnlinePaymentExpirationWorker.name);

  constructor(
    private readonly saleOnlinePaymentService: SaleOnlinePaymentService,
    private readonly auditService: AuditService,
  ) {
    super();
  }

  async process(job: Job<SaleOnlinePaymentExpirationJobData>): Promise<void> {
    if (job.name !== 'sale.expireOnlinePayment') {
      this.logger.warn(`Job inconnu sur la file sale-online-payment-expiration : ${job.name}`);
      return;
    }

    const { intentId, organizationId } = job.data;
    if (!intentId || !organizationId) {
      this.logger.error('sale.expireOnlinePayment sans intentId ou organizationId — job ignoré');
      return;
    }

    try {
      // expirePayment() est un no-op idempotent qui ne lève jamais d'exception métier — que
      // l'intention soit effectivement expirée ici ou déjà résolue (webhook concurrent), le
      // job se termine normalement (§17 point V — compétition webhook/expiration).
      await this.saleOnlinePaymentService.expirePayment(organizationId, intentId);

      await this.auditService.create({
        organizationId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'sale.expireOnlinePayment',
        entity: 'OnlinePaymentIntent',
        entityId: intentId,
      });

      this.logger.log(
        `Intention de paiement en ligne ${intentId} traitée par le job d'expiration (org ${organizationId})`,
      );
    } catch (err) {
      // Erreur inattendue (DB indisponible, etc.) — jamais une exception métier normale
      // (cf. ci-dessus) : on relance pour que BullMQ retente le job plutôt que de perdre
      // silencieusement l'expiration.
      this.logger.error(`sale.expireOnlinePayment : échec pour l'intention ${intentId}`, err);
      throw err;
    }
  }
}
