import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Appelé depuis main.ts pour enregistrer la fermeture propre de Prisma
   * lors des signaux SIGTERM/SIGINT (Kubernetes, PM2, graceful shutdown).
   */
  enableShutdownHooks(app: { close: () => Promise<void> }): void {
    // beforeExit ne se déclenche pas avec SIGTERM — on écoute les signaux OS directement
    process.on('SIGTERM', () => {
      this.logger.log('SIGTERM reçu — fermeture gracieuse en cours');
      void app.close();
    });
  }
}
