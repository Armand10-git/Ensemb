import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

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
   * Ouvre une transaction interactive, pose SET LOCAL app.current_tenant pour que
   * la policy RLS PostgreSQL filtre les lignes du bon tenant, puis exécute le callback.
   *
   * À utiliser pour toute opération nécessitant la garantie RLS en plus du filtre
   * WHERE applicatif (défense en profondeur, §17 point T).
   *
   * SET LOCAL (et non SET) garantit que la variable est effacée à la fin de la
   * transaction — la connexion rendue au pool n'expose pas le contexte du tenant
   * précédent.
   */
  async withTenant<T>(
    organizationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // set_config(name, value, is_local=true) est l'équivalent paramétrable de SET LOCAL.
      // is_local=true garantit que la variable est effacée au commit — jamais de fuite
      // vers la prochaine requête du pool (§17 point T).
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${organizationId}, true)`;
      return fn(tx);
    });
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
