import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { EncryptionModule } from '../common/encryption.module';
import { DocumentCounterModule } from '../common/document-counter.module';
import { BillingModule } from '../modules/billing/billing.module';
import { BackupModule } from '../modules/backup/backup.module';
import { RealtimeModule } from '../modules/realtime/realtime.module';
import { PartnersModule } from '../modules/partners/partners.module';
import { SalesModule } from '../modules/sales/sale.module';
import { QuotationsModule } from '../modules/quotations/quotation.module';
import { PurchasesModule } from '../modules/purchases/purchase.module';
import { ReturnsModule } from '../modules/returns/returns.module';
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
import { PurchaseEmailWorker } from './purchase-email.worker';
import { PaymentReceiptEmailWorker } from './payment-receipt-email.worker';
import { ReturnEmailWorker } from './return-email.worker';

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
    // EncryptionModule et DocumentCounterModule sont @Global() mais doivent tout de même être
    // importés une fois dans CE contexte de bootstrap (WorkerModule a sa propre racine DI,
    // distincte d'AppModule — les commentaires « pas besoin de l'importer, il est global » semés
    // dans SalesModule/InventoryModule/QuotationsModule etc. supposent à tort qu'AppModule est
    // toujours la racine ; c'est faux ici). EncryptionService : nécessaire à
    // PaymentGatewayCredentialService, injecté transitivement via SalesModule → PaymentGatewayModule.
    // DocumentCounterService : nécessaire à AdjustmentService (InventoryModule, via SalesModule) et
    // à QuotationService (génération de référence à la conversion en vente).
    EncryptionModule,
    DocumentCounterModule,
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
    // PurchasesModule exporte PurchaseService/PaymentPurchaseService (S32, PurchaseEmailWorker/PaymentReceiptEmailWorker)
    PurchasesModule,
    // ReturnsModule exporte SaleReturnService/PurchaseReturnService (S32, ReturnEmailWorker)
    ReturnsModule,
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
    PurchaseEmailWorker,
    PaymentReceiptEmailWorker,
    ReturnEmailWorker,
  ],
})
export class WorkerModule {}
