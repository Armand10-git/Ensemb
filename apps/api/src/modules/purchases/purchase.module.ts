import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchaseService } from './purchase.service';
import { PurchaseController } from './purchase.controller';
import { PaymentPurchaseService } from './payment-purchase.service';
import { PaymentPurchaseController } from './payment-purchase.controller';

/**
 * Module du domaine achats fournisseurs (S25 — Bloc F) : achats (création, validation
 * avec incrément de stock, mise à jour, suppression) et paiements fournisseurs. Mirror
 * de SalesModule, sans NotificationModule (pas de stock:lowAlert à l'incrément — rien
 * à notifier).
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * RealtimeModule est importé pour que PurchaseService puisse émettre
 * purchase:created/stock:updated. InventoryModule est importé pour que PurchaseService
 * puisse injecter ProductWarehouseService (adjustStock, verrouillage optimiste).
 */
@Module({
  imports: [PrismaModule, RealtimeModule, InventoryModule],
  controllers: [PurchaseController, PaymentPurchaseController],
  providers: [PurchaseService, PaymentPurchaseService],
  exports: [PurchaseService, PaymentPurchaseService],
})
export class PurchasesModule {}
