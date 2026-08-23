import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

/**
 * Enregistrement seul de la file BullMQ `sale-online-payment-expiration` (S31, §17 point V).
 *
 * Mirror exact de PosPaymentExpirationQueueModule (S22) : module minimal partagé entre
 * SalesModule (producteur — SaleOnlinePaymentService.initiate enfile le job d'expiration à
 * la création d'une intention de paiement en ligne) et WorkerModule (consommateur —
 * SaleOnlinePaymentExpirationWorker) : évite que le worker doive importer tout SalesModule
 * juste pour enregistrer le nom de la file.
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'sale-online-payment-expiration' })],
  exports: [BullModule],
})
export class SaleOnlinePaymentExpirationQueueModule {}
