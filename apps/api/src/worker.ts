import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './workers/worker.module';

/**
 * Point d'entrée du process worker BullMQ dédié (§17 point Z).
 * Démarré indépendamment du serveur HTTP :
 *   ts-node src/worker.ts
 *   OU via PM2 / Docker avec un script séparé.
 *
 * Ce process ne crée pas de serveur HTTP — createApplicationContext suffit.
 */
async function bootstrapWorker(): Promise<void> {
  const logger = new Logger('Worker');

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });

  // Fermeture propre sur SIGTERM (Kubernetes, PM2)
  process.on('SIGTERM', async () => {
    logger.log('SIGTERM reçu — arrêt du worker en cours...');
    await app.close();
    process.exit(0);
  });

  logger.log('Worker BullMQ démarré — en attente de jobs billing');
}

bootstrapWorker();
