import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { WebhookController } from './webhook.controller';
import { QuotaGuard } from './quota.guard';
import { PaymentAggregatorService } from './payment-aggregator.service';

// BillingWorker n'est pas ici : il tourne dans un process worker dédié (§17 point Z).
// Voir apps/api/src/worker.ts et apps/api/src/workers/worker.module.ts.

@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    // File BullMQ — les jobs sont PRODUITS ici (BillingService) et CONSOMMÉS dans le worker dédié
    BullModule.registerQueue({ name: 'billing' }),
  ],
  controllers: [BillingController, WebhookController],
  providers: [BillingService, PaymentAggregatorService, QuotaGuard],
  exports: [BillingService, QuotaGuard],
})
export class BillingModule {}
