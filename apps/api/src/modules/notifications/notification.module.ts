import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';

/**
 * Module de notifications persistantes (S18 — §17 point I).
 *
 * Exporté pour que InventoryModule puisse injecter NotificationService dans
 * AdjustmentService et StockTransferService via createForOrg().
 */
@Module({
  imports: [PrismaModule, RealtimeModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
