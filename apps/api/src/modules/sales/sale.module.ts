import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationModule } from '../notifications/notification.module';
import { MessagingQueueModule } from '../messaging/messaging-queue.module';
import { SaleService } from './sale.service';
import { SaleController } from './sale.controller';
import { PaymentSaleService } from './payment-sale.service';
import { PaymentSaleController } from './payment-sale.controller';

/**
 * Module du domaine ventes classiques hors-POS : ventes (S19), paiements de ventes
 * (S20) et validation de vente avec mouvement de stock (S21 — Bloc E). Un seul module
 * pour tout le domaine, cohérent avec l'architecture actuelle — pas de module séparé
 * pour PaymentSale.
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * RealtimeModule est importé pour que SaleService puisse émettre sale:created/stock:updated.
 * InventoryModule est importé pour que SaleService puisse injecter ProductWarehouseService
 * (adjustStock, verrouillage optimiste, S21). NotificationModule pour createForOrg
 * (stock.lowAlert persistant, patron StockTransferService). MessagingQueueModule (S24)
 * pour injecter les files BullMQ 'email'/'sms' (envoi du récapitulatif de vente).
 */
@Module({
  imports: [PrismaModule, RealtimeModule, InventoryModule, NotificationModule, MessagingQueueModule],
  controllers: [SaleController, PaymentSaleController],
  providers: [SaleService, PaymentSaleService],
  exports: [SaleService, PaymentSaleService],
})
export class SalesModule {}
