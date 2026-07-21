import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ProductWarehouseService } from './product-warehouse.service';
import { AdjustmentService } from './adjustment.service';
import { InventoryController } from './inventory.controller';
import { AdjustmentController } from './adjustment.controller';

/**
 * Module de gestion du stock (S15 + S16 — Bloc D).
 *
 * S15 : ProductWarehouseService + InventoryController (stock par produit/entrepôt)
 * S16 : AdjustmentService + AdjustmentController (ajustements DRAFT → VALIDATED)
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * RealtimeModule est importé pour que AdjustmentService puisse émettre stock:updated.
 */
@Module({
  imports: [PrismaModule, RealtimeModule],
  controllers: [InventoryController, AdjustmentController],
  providers: [ProductWarehouseService, AdjustmentService],
  exports: [ProductWarehouseService, AdjustmentService],
})
export class InventoryModule {}
