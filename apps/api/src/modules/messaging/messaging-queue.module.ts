import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

/**
 * Enregistrement seul des files BullMQ `email` et `sms` (S24, envoi de récapitulatif de vente).
 *
 * Module minimal partagé entre le producteur (le contrôleur POST /api/v1/sales/:id/send,
 * apps/api/src/modules/sales/) et WorkerModule (consommateurs — SaleEmailWorker,
 * SaleSmsWorker) : évite que le worker doive importer tout MessagingModule (EmailService,
 * SmsService) juste pour enregistrer les noms de file — patron identique à
 * PosPaymentExpirationQueueModule.
 *
 * defaultJobOptions : 3 tentatives avec backoff exponentiel (délai initial 5s) — BullMQ
 * retente automatiquement en cas d'échec transitoire (ex. SMTP momentanément indisponible),
 * jamais de retry infini.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'email',
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    }),
    BullModule.registerQueue({
      name: 'sms',
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    }),
  ],
  exports: [BullModule],
})
export class MessagingQueueModule {}
