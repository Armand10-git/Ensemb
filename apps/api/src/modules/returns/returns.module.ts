import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationModule } from '../notifications/notification.module';
import { MessagingQueueModule } from '../messaging/messaging-queue.module';
import { SaleReturnService } from './sale-return.service';
import { SaleReturnController } from './sale-return.controller';
import { PurchaseReturnService } from './purchase-return.service';
import { PurchaseReturnController } from './purchase-return.controller';
import { PaymentReturnService } from './payment-return.service';
import { PaymentSaleReturnController } from './payment-sale-return.controller';
import { PaymentPurchaseReturnController } from './payment-purchase-return.controller';

/**
 * Module du domaine retours de vente et d'achat (S26, §18.6) : SaleReturn (création,
 * validation avec incrément de stock), PurchaseReturn (création, validation avec
 * décrément de stock) et PaymentReturn (remboursements partagés entre les deux sens).
 * Mirror de SalesModule/PurchasesModule.
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici. RealtimeModule
 * pour les événements saleReturn:created/purchaseReturn:created/stock:updated.
 * InventoryModule pour ProductWarehouseService (adjustStock, verrouillage optimiste).
 * NotificationModule pour stock:lowAlert persisté (PurchaseReturnService uniquement —
 * un retour fournisseur diminue le stock, contrairement à un retour de vente).
 * MessagingQueueModule (S32) pour injecter la file BullMQ 'email' (envoi du récapitulatif
 * de retour de vente et de retour fournisseur).
 */
@Module({
  imports: [PrismaModule, RealtimeModule, InventoryModule, NotificationModule, MessagingQueueModule],
  controllers: [
    SaleReturnController,
    PurchaseReturnController,
    PaymentSaleReturnController,
    PaymentPurchaseReturnController,
  ],
  providers: [SaleReturnService, PurchaseReturnService, PaymentReturnService],
  exports: [SaleReturnService, PurchaseReturnService, PaymentReturnService],
})
export class ReturnsModule {}
