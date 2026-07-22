import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationModule } from '../notifications/notification.module';
import { ProductWarehouseService } from './product-warehouse.service';
import { AdjustmentService } from './adjustment.service';
import { StockTransferService } from './stock-transfer.service';
import { InventoryController } from './inventory.controller';
import { AdjustmentController } from './adjustment.controller';
import { StockTransferController } from './stock-transfer.controller';

/**
 * Module de gestion du stock (S15 + S16 + S17 — Bloc D).
 *
 * S15 : ProductWarehouseService + InventoryController (stock par produit/entrepôt)
 * S16 : AdjustmentService + AdjustmentController (ajustements DRAFT → VALIDATED)
 * S17 : StockTransferService + StockTransferController (transferts DRAFT → VALIDATED)
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * RealtimeModule est importé pour que AdjustmentService/StockTransferService puissent émettre stock:updated.
 */
@Module({
  imports: [PrismaModule, RealtimeModule, NotificationModule],
  controllers: [InventoryController, AdjustmentController, StockTransferController],
  providers: [ProductWarehouseService, AdjustmentService, StockTransferService],
  exports: [ProductWarehouseService, AdjustmentService, StockTransferService],
})
export class InventoryModule {}
