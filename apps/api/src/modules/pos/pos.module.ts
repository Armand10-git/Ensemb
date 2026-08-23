import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationModule } from '../notifications/notification.module';
import { SalesModule } from '../sales/sale.module';
import { PaymentGatewayModule } from '../payment-gateway/payment-gateway.module';
import { CashSessionModule } from '../cash-sessions/cash-session.module';
import { PosPaymentExpirationQueueModule } from './pos-payment-expiration-queue.module';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';

/**
 * Module du parcours vente au comptoir (S22 — Bloc E, §18.2).
 *
 * SalesModule : réutilise PaymentSaleService.createInTransaction (encaissement CASH
 * immédiat, même calcul paidAmount/paymentStatus que la vente classique, S20).
 * PaymentGatewayModule (S31) : réutilise AsyncPaymentService.generatePaymentLinkFor pour
 * générer le lien de paiement CARD/MOBILE_MONEY (agrégateur PAR ORGANISATION, remplace
 * PaymentAggregatorService — compte plateforme — pour ce flux) ; PosService.confirmAsyncPayment
 * consomme le contrat AggregatorPaymentConfirmation (payment-provider.util.ts) partagé avec la
 * vente classique. Le webhook mobile money/carte est désormais généralisé et vit dans
 * PaymentsWebhookModule (PaymentsWebhookController appelle PosService.confirmAsyncPayment
 * directement) — PosModule n'expose donc plus lui-même de contrôleur webhook, et n'a plus besoin
 * de BillingModule (PaymentAggregatorService, compte plateforme) qui ne servait qu'à l'ancien
 * webhook.
 * PosPaymentExpirationQueueModule : enregistre la file consommée par le worker dédié
 * (apps/api/src/workers/pos-payment-expiration.worker.ts, §17 point Z).
 * CashSessionModule (S23b) : réutilise CashSessionService.findOpenSessionInTransaction —
 * createSale() exige désormais une session de caisse OPEN pour (organizationId, userId,
 * warehouseId) et y rattache la vente créée (cashSessionId), vérifié dans la même transaction
 * Serializable pour éliminer tout TOCTOU avec une clôture concurrente.
 */
@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    InventoryModule,
    NotificationModule,
    SalesModule,
    PaymentGatewayModule,
    CashSessionModule,
    PosPaymentExpirationQueueModule,
  ],
  controllers: [PosController],
  providers: [PosService],
  exports: [PosService],
})
export class PosModule {}
