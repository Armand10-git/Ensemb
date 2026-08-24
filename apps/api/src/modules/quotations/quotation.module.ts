import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MessagingQueueModule } from '../messaging/messaging-queue.module';
import { PdfQueueModule } from '../pdf/pdf-queue.module';
import { QuotationService } from './quotation.service';
import { QuotationController } from './quotation.controller';

/**
 * Module du domaine devis (S28, §18.4).
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * RealtimeModule est importé pour que QuotationService puisse émettre
 * quotation:created/sale:created (convert()). MessagingQueueModule pour injecter les
 * files BullMQ 'email'/'sms' (envoi du récapitulatif de devis, mirror S24).
 *
 * PAS d'InventoryModule (aucun mouvement de stock, jamais, pour un devis) ni de
 * NotificationModule (aucune alerte stock possible ici) — contrairement à SalesModule.
 */
@Module({
  imports: [PrismaModule, RealtimeModule, MessagingQueueModule, PdfQueueModule],
  controllers: [QuotationController],
  providers: [QuotationService],
  exports: [QuotationService],
})
export class QuotationsModule {}
