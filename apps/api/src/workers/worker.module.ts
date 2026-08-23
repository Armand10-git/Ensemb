import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BillingModule } from '../modules/billing/billing.module';
import { BackupModule } from '../modules/backup/backup.module';
import { RealtimeModule } from '../modules/realtime/realtime.module';
import { PartnersModule } from '../modules/partners/partners.module';
import { SalesModule } from '../modules/sales/sale.module';
import { QuotationsModule } from '../modules/quotations/quotation.module';
import { AuditModule } from '../modules/audit/audit.module';
import { PosPaymentExpirationQueueModule } from '../modules/pos/pos-payment-expiration-queue.module';
import { SaleOnlinePaymentExpirationQueueModule } from '../modules/sales/sale-online-payment-expiration-queue.module';
import { MessagingModule } from '../modules/messaging/messaging.module';
import { MessagingQueueModule } from '../modules/messaging/messaging-queue.module';
import { BillingWorker } from './billing.worker';
import { BackupWorker } from './backup.worker';
import { ExcelWorker } from './excel.worker';
import { PosPaymentExpirationWorker } from './pos-payment-expiration.worker';
import { SaleOnlinePaymentExpirationWorker } from './sale-online-payment-expiration.worker';
import { SaleEmailWorker } from './sale-email.worker';
import { SaleSmsWorker } from './sale-sms.worker';
import { QuotationEmailWorker } from './quotation-email.worker';
import { QuotationSmsWorker } from './quotation-sms.worker';

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
    // SalesModule exporte SaleService (PosPaymentExpirationWorker réutilise cancel(), S21b/S22)
    // et SaleOnlinePaymentService (SaleOnlinePaymentExpirationWorker, S31)
    SalesModule,
    // QuotationsModule exporte QuotationService (nécessaire pour QuotationEmailWorker/QuotationSmsWorker)
    QuotationsModule,
    // AuditModule exporte AuditService (journalisation directe, aucun contexte HTTP dans un processor)
    AuditModule,
    // Enregistre la file 'pos-payment-expiration' (nécessaire pour @Processor('pos-payment-expiration')) —
    // module dédié plutôt que PosModule entier, pour éviter d'entraîner sa dépendance croisée vers BillingModule
    PosPaymentExpirationQueueModule,
    // Enregistre la file 'sale-online-payment-expiration' (nécessaire pour
    // @Processor('sale-online-payment-expiration')) — même patron que PosPaymentExpirationQueueModule (S31)
    SaleOnlinePaymentExpirationQueueModule,
    // MessagingModule exporte EmailService et SmsService (S24, SaleEmailWorker/SaleSmsWorker)
    MessagingModule,
    // Enregistre les files 'email' et 'sms' (nécessaire pour @Processor('email')/@Processor('sms')) —
    // module dédié plutôt que d'importer un module métier, même patron que PosPaymentExpirationQueueModule
    MessagingQueueModule,
  ],
  providers: [
    BillingWorker,
    BackupWorker,
    ExcelWorker,
    PosPaymentExpirationWorker,
    SaleOnlinePaymentExpirationWorker,
    SaleEmailWorker,
    SaleSmsWorker,
    QuotationEmailWorker,
    QuotationSmsWorker,
  ],
})
export class WorkerModule {}
