/**
 * Test de fumée du bootstrap de WorkerModule — non-régression du bug découvert en dehors du
 * plan de session (S30, post-mortem crash-loop `ensemb-worker-1`) : `EncryptionModule` et
 * `DocumentCounterModule` sont `@Global()`, mais cette globalité ne s'applique qu'à la racine de
 * bootstrap où ils sont réellement importés. `AppModule` (serveur HTTP) les importe directement,
 * ce qui masquait le problème ; `WorkerModule` a sa propre racine DI indépendante et ne les
 * important pas provoquait `UnknownDependenciesException` au démarrage — le process quittait
 * avec un stack trace (ou, avant l'implémentation réelle des workers, se terminait silencieusement
 * en exit code 0), provoquant une boucle de redémarrage infinie côté conteneur Docker
 * (`restart: unless-stopped`), aucun job BullMQ n'ayant jamais été consommé.
 *
 * Aucun test existant n'instanciait `WorkerModule` dans son ensemble (chaque worker n'est
 * unit-testé qu'avec des dépendances mockées au constructeur) — ce test comble ce trou en
 * bootant le vrai graphe de dépendances Nest, exactement comme `apps/api/src/worker.ts` le fait
 * en production/Docker.
 */

import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../src/workers/worker.module';

jest.setTimeout(30_000);

describe('WorkerModule (bootstrap)', () => {
  it('démarre sans erreur de résolution de dépendances (createApplicationContext)', async () => {
    const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    await app.close();
  });
});
