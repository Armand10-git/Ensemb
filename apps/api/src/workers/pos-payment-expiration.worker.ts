import { Processor, WorkerHost } from '@nestjs/bullmq';
import { BadRequestException, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SaleService } from '../modules/sales/sale.service';
import { AuditService } from '../modules/audit/audit.service';

export interface PosPaymentExpirationJobData {
  saleId: string;
  organizationId: string;
}

/**
 * Worker BullMQ dédié à l'expiration des ventes POS en attente de paiement mobile money
 * (S22, §18.2 étape 10 ; §17 point V). Tourne dans le process worker dédié (§17 point Z),
 * jamais dans le process HTTP.
 *
 * Un seul job : `pos.expirePayment`, enfilé par PosService.createSale avec un délai
 * POS_PAYMENT_TIMEOUT_MS (défaut 3 min) à la création d'une vente CARD ou MOBILE_MONEY (S31).
 *
 * Appelle SaleService.expireAwaitingPayment() (S31 — distincte de cancel(), réservée à
 * l'annulation manuelle d'une vente COMPLETED) : n'accepte QUE le statut AWAITING_PAYMENT,
 * pour ne jamais restituer le stock une seconde fois si le webhook de confirmation a gagné
 * la course entre-temps (vente déjà COMPLETED), cf. JSDoc de SaleService.expireAwaitingPayment().
 * Aucun contexte HTTP dans un processor : @Auditable (qui lit req.user) ne s'applique pas ici —
 * l'audit est journalisé directement via AuditService.create(actorType: 'SYSTEM', actorId: null).
 */
@Processor('pos-payment-expiration')
export class PosPaymentExpirationWorker extends WorkerHost {
  private readonly logger = new Logger(PosPaymentExpirationWorker.name);

  constructor(
    private readonly saleService: SaleService,
    private readonly auditService: AuditService,
  ) {
    super();
  }

  async process(job: Job<PosPaymentExpirationJobData>): Promise<void> {
    if (job.name !== 'pos.expirePayment') {
      this.logger.warn(`Job inconnu sur la file pos-payment-expiration : ${job.name}`);
      return;
    }

    const { saleId, organizationId } = job.data;
    if (!saleId || !organizationId) {
      this.logger.error('pos.expirePayment sans saleId ou organizationId — job ignoré');
      return;
    }

    try {
      const cancelled = await this.saleService.expireAwaitingPayment(
        saleId,
        organizationId,
        'Expiration du délai de paiement mobile money',
      );

      await this.auditService.create({
        organizationId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'pos.expirePayment',
        entity: 'Sale',
        entityId: saleId,
        after: { status: cancelled.status, cancelReason: cancelled.cancelReason },
      });

      this.logger.log(`Vente POS ${saleId} expirée (mobile money) — stock restitué`);
    } catch (err) {
      if (err instanceof BadRequestException) {
        // Vente déjà COMPLETED (webhook arrivé entre-temps) ou déjà CANCELLED : cas normal
        // de compétition webhook/expiration, pas une erreur — no-op idempotent.
        this.logger.log(
          `pos.expirePayment : vente ${saleId} déjà résolue (webhook ou annulation concurrente) — no-op`,
        );
        return;
      }
      // ConflictException (verrouillage optimiste/sérialisation) ou erreur inattendue :
      // on relance pour que BullMQ retente le job plutôt que de perdre silencieusement la restitution.
      this.logger.error(`pos.expirePayment : échec pour la vente ${saleId}`, err);
      throw err;
    }
  }
}
