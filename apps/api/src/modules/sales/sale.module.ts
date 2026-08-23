import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationModule } from '../notifications/notification.module';
import { MessagingQueueModule } from '../messaging/messaging-queue.module';
import { PaymentGatewayModule } from '../payment-gateway/payment-gateway.module';
import { SaleService } from './sale.service';
import { SaleController } from './sale.controller';
import { PaymentSaleService } from './payment-sale.service';
import { PaymentSaleController } from './payment-sale.controller';
import { SaleOnlinePaymentService } from './sale-online-payment.service';
import { SaleOnlinePaymentController } from './sale-online-payment.controller';
import { SaleOnlinePaymentExpirationQueueModule } from './sale-online-payment-expiration-queue.module';

/**
 * Module du domaine ventes classiques hors-POS : ventes (S19), paiements de ventes
 * (S20), validation de vente avec mouvement de stock (S21 — Bloc E) et paiement en ligne
 * différé via agrégateur (S31, §17 point V). Un seul module pour tout le domaine, cohérent
 * avec l'architecture actuelle — pas de module séparé pour PaymentSale/SaleOnlinePayment.
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * RealtimeModule est importé pour que SaleService/SaleOnlinePaymentService puissent émettre
 * sale:created/stock:updated/sale:updated. InventoryModule est importé pour que SaleService
 * puisse injecter ProductWarehouseService (adjustStock, verrouillage optimiste, S21).
 * NotificationModule pour createForOrg (stock.lowAlert persistant, patron
 * StockTransferService). MessagingQueueModule (S24) pour injecter les files BullMQ
 * 'email'/'sms' (envoi du récapitulatif de vente). PaymentGatewayModule (S31) pour injecter
 * AsyncPaymentService (génération du lien de paiement agrégateur). Le nouveau
 * SaleOnlinePaymentExpirationQueueModule (S31) enregistre la file
 * 'sale-online-payment-expiration' (nécessaire pour @InjectQueue dans
 * SaleOnlinePaymentService).
 *
 * SaleOnlinePaymentService est exporté : un futur contrôleur webhook généralisé (écrit
 * séparément) devra pouvoir l'appeler depuis un autre module en important SalesModule.
 */
@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    InventoryModule,
    NotificationModule,
    MessagingQueueModule,
    PaymentGatewayModule,
    SaleOnlinePaymentExpirationQueueModule,
  ],
  controllers: [SaleController, PaymentSaleController, SaleOnlinePaymentController],
  providers: [SaleService, PaymentSaleService, SaleOnlinePaymentService],
  exports: [SaleService, PaymentSaleService, SaleOnlinePaymentService],
})
export class SalesModule {}
