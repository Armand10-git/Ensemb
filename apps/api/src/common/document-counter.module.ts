import { Global, Module } from '@nestjs/common';
import { PrismaModule } from './prisma.module';
import { DocumentCounterService } from './document-counter.service';

/**
 * Module global de génération transactionnelle des références de documents (§17 point X).
 * Déclaré @Global() pour être injecté dans tout module sans import explicite.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [DocumentCounterService],
  exports: [DocumentCounterService],
})
export class DocumentCounterModule {}
