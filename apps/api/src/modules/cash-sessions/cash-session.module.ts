import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { CashSessionService } from './cash-session.service';
import { CashSessionController } from './cash-session.controller';

/**
 * Module des sessions de caisse (S23b — Bloc E, §18.2).
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * CashSessionService est exporté pour que PosModule puisse l'importer (findOpenSessionInTransaction
 * consommé par PosService.createSale — cf. JSDoc de la méthode).
 */
@Module({
  imports: [PrismaModule],
  controllers: [CashSessionController],
  providers: [CashSessionService],
  exports: [CashSessionService],
})
export class CashSessionModule {}
