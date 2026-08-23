import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { PosModule } from '../pos/pos.module';
import { SalesModule } from '../sales/sale.module';
import { PaymentGatewayModule } from './payment-gateway.module';
import { PaymentsWebhookController } from './payments-webhook.controller';

/**
 * Module dédié au webhook paiement généralisé (S31) : `PaymentsWebhookController` dépend à la
 * fois de `PosModule` (PosService.confirmAsyncPayment) et `SalesModule`
 * (SaleOnlinePaymentService.confirmPayment) — l'isoler ici évite que l'un de ces deux modules
 * métier importe l'autre (ils restent indépendants), et évite tout cycle avec
 * `PaymentGatewayModule` (que PosModule/SalesModule importent déjà pour AsyncPaymentService).
 */
@Module({
  imports: [PrismaModule, PosModule, SalesModule, PaymentGatewayModule],
  controllers: [PaymentsWebhookController],
})
export class PaymentsWebhookModule {}
