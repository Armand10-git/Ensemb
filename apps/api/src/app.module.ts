import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './common/prisma.module';
import { RedisModule } from './common/redis.module';
import { EncryptionModule } from './common/encryption.module';
import { DocumentCounterModule } from './common/document-counter.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { RolesModule } from './modules/roles/roles.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AuditModule } from './modules/audit/audit.module';
import { RegistrationModule } from './modules/registration/registration.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { BillingModule } from './modules/billing/billing.module';
import { SmtpModule } from './modules/smtp/smtp.module';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module';
import { BackupModule } from './modules/backup/backup.module';
import { CurrencyModule } from './modules/currency/currency.module';
import { WarehouseModule } from './modules/warehouse/warehouse.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { PartnersModule } from './modules/partners/partners.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { NotificationModule } from './modules/notifications/notification.module';
import { SalesModule } from './modules/sales/sale.module';
import { PurchasesModule } from './modules/purchases/purchase.module';
import { CashSessionModule } from './modules/cash-sessions/cash-session.module';
import { PosModule } from './modules/pos/pos.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { QuotationsModule } from './modules/quotations/quotation.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { PaymentGatewayModule } from './modules/payment-gateway/payment-gateway.module';
import { PaymentsWebhookModule } from './modules/payment-gateway/payments-webhook.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting global : 20 req/min par IP par défaut ; routes spécifiques via @Throttle()
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    // Connexion BullMQ globale — partagée par toutes les queues (billing, backup, etc.)
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    PrismaModule,
    RedisModule,
    EncryptionModule,
    DocumentCounterModule,
    TenancyModule,
    HealthModule,
    AuthModule,
    RolesModule,
    RealtimeModule,
    AuditModule,
    RegistrationModule,
    OrganizationsModule,
    BillingModule,
    SmtpModule,
    PlatformAdminModule,
    BackupModule,
    CurrencyModule,
    WarehouseModule,
    CatalogModule,
    PartnersModule,
    UploadsModule,
    InventoryModule,
    NotificationModule,
    SalesModule,
    PurchasesModule,
    CashSessionModule,
    PosModule,
    ReturnsModule,
    QuotationsModule,
    ExpensesModule,
    PaymentGatewayModule,
    PaymentsWebhookModule,
  ],
})
export class AppModule {}
