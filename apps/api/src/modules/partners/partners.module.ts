import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { PrismaModule } from '../../common/prisma.module';
import { PartnersService } from './partners.service';
import { ClientsController } from './clients.controller';
import { ProvidersController } from './providers.controller';

/**
 * Module partenaires tenant (S12 — Bloc C).
 * Fournit CRUD clients/fournisseurs, import CSV et déclenchement d'export Excel.
 *
 * La queue 'excel' est enregistrée ici (producteur) ; le consommateur (ExcelWorker)
 * tourne dans WorkerModule (§17 point Z — jamais dans le process HTTP).
 */
@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: 'excel' }),
    MulterModule.register({}),
  ],
  controllers: [ClientsController, ProvidersController],
  providers: [PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
