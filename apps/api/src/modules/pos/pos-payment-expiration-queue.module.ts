import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

/**
 * Enregistrement seul de la file BullMQ `pos-payment-expiration` (S22, §17 point V).
 *
 * Module minimal partagé entre PosModule (producteur — PosService.createSale enfile le
 * job d'expiration mobile money) et WorkerModule (consommateur —
 * PosPaymentExpirationWorker) : évite que le worker doive importer tout PosModule (et
 * sa dépendance croisée vers BillingModule pour PaymentAggregatorService) juste pour
 * enregistrer le nom de la file.
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'pos-payment-expiration' })],
  exports: [BullModule],
})
export class PosPaymentExpirationQueueModule {}
