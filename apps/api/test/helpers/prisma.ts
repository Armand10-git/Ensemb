/**
 * Singleton PrismaClient partagé entre tous les specs e2e d'un même worker Jest.
 *
 * Avec maxWorkers:1, tous les specs tournent dans le même processus Node.
 * Utiliser un singleton évite de créer N connexions TCP en TIME_WAIT (une par spec).
 * La déconnexion est assurée par le gestionnaire de sortie de processus — ne jamais
 * appeler $disconnect() dans les afterAll individuels.
 */
import { PrismaClient } from '@prisma/client';

let _client: PrismaClient | undefined;

export function getTestPrisma(): PrismaClient {
  if (!_client) {
    _client = new PrismaClient();
    // Déconnexion propre sur exit — forceExit:true de Jest déclenchera cet événement
    process.once('exit', () => {
      // $disconnect est async mais exit handler est synchrone — Prisma gère ce cas
      void _client?.$disconnect();
    });
  }
  return _client;
}
