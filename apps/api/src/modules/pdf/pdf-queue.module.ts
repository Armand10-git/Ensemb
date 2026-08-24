import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

/**
 * Enregistrement seul de la file BullMQ `pdf` (S34, génération PDF vente/achat/devis/retour).
 *
 * Module minimal partagé entre les producteurs (les contrôleurs POST .../:id/pdf de
 * SalesModule, PurchasesModule, QuotationsModule, ReturnsModule) et WorkerModule
 * (consommateurs — SalePdfWorker, PurchasePdfWorker, QuotationPdfWorker, ReturnPdfWorker) :
 * même patron que MessagingQueueModule/PosPaymentExpirationQueueModule — évite que chaque
 * module producteur ou le worker n'importe un module métier complet juste pour enregistrer
 * le nom de la file.
 *
 * defaultJobOptions : 3 tentatives avec backoff exponentiel (délai initial 5s) — Puppeteer
 * peut échouer transitoirement (pic mémoire, navigateur non démarré) ; BullMQ retente
 * automatiquement, jamais de retry infini.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'pdf',
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    }),
  ],
  exports: [BullModule],
})
export class PdfQueueModule {}
