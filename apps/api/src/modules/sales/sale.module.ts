import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SaleService } from './sale.service';
import { SaleController } from './sale.controller';

/**
 * Module des ventes classiques hors-POS (S19 — Bloc E).
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * RealtimeModule est importé pour que SaleService puisse émettre sale:created.
 */
@Module({
  imports: [PrismaModule, RealtimeModule],
  controllers: [SaleController],
  providers: [SaleService],
  exports: [SaleService],
})
export class SalesModule {}
