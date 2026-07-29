import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationModule } from '../notifications/notification.module';
import { SalesModule } from '../sales/sale.module';
import { BillingModule } from '../billing/billing.module';
import { CashSessionModule } from '../cash-sessions/cash-session.module';
import { PosPaymentExpirationQueueModule } from './pos-payment-expiration-queue.module';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';
import { PosWebhookController } from './pos-webhook.controller';

/**
 * Module du parcours vente au comptoir (S22 — Bloc E, §18.2).
 *
 * SalesModule : réutilise PaymentSaleService.createInTransaction (encaissement CASH/CARD
 * immédiat, même calcul paidAmount/paymentStatus que la vente classique, S20).
 * BillingModule : réutilise PaymentAggregatorService (lien de paiement, vérification HMAC) —
 * dépendance à sens unique (PosModule → BillingModule) : le webhook mobile money POS vit ici
 * (PosWebhookController), jamais dans BillingModule, pour ne jamais créer de dépendance
 * croisée qui ferait hériter BillingModule des dépendances transitives de PosModule
 * (InventoryModule, SalesModule…) — un import isolé de BillingModule (ex. un test e2e billing
 * minimal) doit rester valide sans PosModule.
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
    BillingModule,
    CashSessionModule,
    PosPaymentExpirationQueueModule,
  ],
  controllers: [PosController, PosWebhookController],
  providers: [PosService],
  exports: [PosService],
})
export class PosModule {}
