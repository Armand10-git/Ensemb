import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';

// BackupWorker n'est pas ici : il tourne dans un process worker dédié (§17 point Z).
// Voir apps/api/src/worker.ts et apps/api/src/workers/worker.module.ts.

@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    // File BullMQ — les jobs sont PRODUITS ici (BackupService) et CONSOMMÉS dans le worker dédié
    BullModule.registerQueue({ name: 'backup' }),
  ],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
