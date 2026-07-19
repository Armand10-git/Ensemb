import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BillingModule } from '../modules/billing/billing.module';
import { RealtimeModule } from '../modules/realtime/realtime.module';
import { BillingWorker } from './billing.worker';

/**
 * Module chargé uniquement dans le process worker dédié (apps/api/src/worker.ts).
 * Ne doit jamais être importé dans AppModule — le serveur HTTP ne consomme pas de jobs BullMQ.
 *
 * Architecture (§17 point Z) :
 *   - AppModule  → produit des jobs dans la file (BillingService.billingQueue.add)
 *   - WorkerModule → consomme les jobs (BillingWorker.process)
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    // BillingModule exporte BillingService (nécessaire pour BillingWorker)
    // et enregistre la queue 'billing' (nécessaire pour @Processor('billing'))
    BillingModule,
    RealtimeModule,
  ],
  providers: [BillingWorker],
})
export class WorkerModule {}
