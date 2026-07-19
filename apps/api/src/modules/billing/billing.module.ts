import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { WebhookController } from './webhook.controller';
import { QuotaGuard } from './quota.guard';
import { PaymentAggregatorService } from './payment-aggregator.service';
import { BillingWorker } from '../../workers/billing.worker';

@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    // File BullMQ dédiée à la facturation — connexion Redis via REDIS_URL (ConfigModule global)
    BullModule.registerQueue({ name: 'billing' }),
  ],
  controllers: [BillingController, WebhookController],
  providers: [BillingService, PaymentAggregatorService, QuotaGuard, BillingWorker],
  exports: [BillingService, QuotaGuard],
})
export class BillingModule {}
