/**
 * Entrypoint du process worker BullMQ dédié (§12.1).
 * Les queues et consumers seront déclarés lors des sessions Bloc B+.
 */
import 'reflect-metadata';

async function startWorker(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[worker] BullMQ worker démarré — en attente de jobs');
}

startWorker();
