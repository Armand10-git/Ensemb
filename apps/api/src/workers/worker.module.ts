import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BillingModule } from '../modules/billing/billing.module';
import { BackupModule } from '../modules/backup/backup.module';
import { RealtimeModule } from '../modules/realtime/realtime.module';
import { PartnersModule } from '../modules/partners/partners.module';
import { BillingWorker } from './billing.worker';
import { BackupWorker } from './backup.worker';
import { ExcelWorker } from './excel.worker';

/**
 * Module chargé uniquement dans le process worker dédié (apps/api/src/worker.ts).
 * Ne doit jamais être importé dans AppModule — le serveur HTTP ne consomme pas de jobs BullMQ.
 *
 * Architecture (§17 point Z) :
 *   - AppModule    → produit des jobs dans les files (BillingService, BackupService, PartnersService)
 *   - WorkerModule → consomme les jobs (BillingWorker, BackupWorker, ExcelWorker)
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
    // BackupModule exporte BackupService (nécessaire pour BackupWorker)
    // et enregistre la queue 'backup' (nécessaire pour @Processor('backup'))
    BackupModule,
    // PartnersModule enregistre la queue 'excel' (nécessaire pour @Processor('excel'))
    // et expose PrismaService via PrismaModule pour ExcelWorker
    PartnersModule,
    RealtimeModule,
  ],
  providers: [BillingWorker, BackupWorker, ExcelWorker],
})
export class WorkerModule {}
