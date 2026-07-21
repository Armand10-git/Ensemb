import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { ProductWarehouseService } from './product-warehouse.service';
import { InventoryController } from './inventory.controller';

@Module({
  imports: [PrismaModule],
  controllers: [InventoryController],
  providers: [ProductWarehouseService],
  exports: [ProductWarehouseService],
})
export class InventoryModule {}
