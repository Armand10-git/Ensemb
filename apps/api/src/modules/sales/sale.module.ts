import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SaleService } from './sale.service';
import { SaleController } from './sale.controller';
import { PaymentSaleService } from './payment-sale.service';
import { PaymentSaleController } from './payment-sale.controller';

/**
 * Module du domaine ventes classiques hors-POS : ventes (S19) et paiements de ventes
 * (S20 — Bloc E). Un seul module pour tout le domaine, cohérent avec l'architecture
 * actuelle — pas de module séparé pour PaymentSale.
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * RealtimeModule est importé pour que SaleService puisse émettre sale:created.
 */
@Module({
  imports: [PrismaModule, RealtimeModule],
  controllers: [SaleController, PaymentSaleController],
  providers: [SaleService, PaymentSaleService],
  exports: [SaleService, PaymentSaleService],
})
export class SalesModule {}
