import { PrismaClient } from '@prisma/client';

/**
 * Tests d'isolation RLS (T03) — défense en profondeur multi-tenant.
 *
 * Scénario principal : simule la réutilisation de connexion d'un pool.
 * - Dans une transaction en tant que ensemb_app (non-superuser) avec set_config(local=true)
 *   → seules les lignes du tenant courant sont visibles.
 * - Hors transaction (pas de set_config) → RLS bloque toutes les lignes (fail-closed).
 * - is_local=true garantit que la variable est effacée au commit — aucune fuite vers la
 *   connexion réutilisée depuis le pool (§17 point T).
 *
 * Note : POSTGRES_USER est superuser → bypass RLS. Les requêtes d'isolation utilisent
 * SET ROLE ensemb_app (non-superuser créé par la migration T03) pour être soumises aux
 * policies. Les opérations admin (setup/teardown) restent en superuser.
 *
 * Requiert DATABASE_URL pointant sur la Postgres de dev/test avec RLS activé (migration T03).
 */

const prisma = new PrismaClient();

const SUFFIX = Date.now();
const SUB_A = `test-t03-a-${SUFFIX}`;
const SUB_B = `test-t03-b-${SUFFIX}`;

let orgAId: string;
let orgBId: string;
let userAId: string;
let userBId: string;

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Pose app.current_tenant pour la transaction courante.
 * set_config(name, value, is_local=true) est l'équivalent paramétrable de SET LOCAL.
 */
async function setTenant(tx: TxClient, id: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${id}, true)`;
}

beforeAll(async () => {
  const [orgA, orgB] = await Promise.all([
    prisma.organization.create({ data: { name: 'Org A T03', subdomain: SUB_A } }),
    prisma.organization.create({ data: { name: 'Org B T03', subdomain: SUB_B } }),
  ]);
  orgAId = orgA.id;
  orgBId = orgB.id;

  // Inserts via superuser (ensemb) : pas de RLS bloquant pour le setup.
  const userA = await prisma.user.create({
    data: {
      organizationId: orgAId,
      firstname: 'Alice',
      lastname: 'T03',
      email: `alice-${SUFFIX}@t03.test`,
      username: `alice-${SUFFIX}`,
      password: 'hashed',
    },
  });
  userAId = userA.id;

  const userB = await prisma.user.create({
    data: {
      organizationId: orgBId,
      firstname: 'Bob',
      lastname: 'T03',
      email: `bob-${SUFFIX}@t03.test`,
      username: `bob-${SUFFIX}`,
      password: 'hashed',
    },
  });
  userBId = userB.id;
});

afterAll(async () => {
  // Suppression via superuser — pas de RLS bloquant.
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { subdomain: { startsWith: 'test-t03-' } } });
  await prisma.$disconnect();
});

describe('RLS — isolation inter-tenant', () => {
  it('dans une transaction ensemb_app avec set_config(orgA) → ne voit que les users de orgA', async () => {
    const users = await prisma.$transaction(async (tx) => {
      // SET ROLE ensemb_app → soumet la session aux policies RLS (non-superuser).
      await tx.$executeRawUnsafe('SET ROLE ensemb_app');
      await setTenant(tx, orgAId);
      const result = await tx.user.findMany();
      await tx.$executeRawUnsafe('RESET ROLE');
      return result;
    });

    const ids = users.map((u) => u.id);
    expect(ids).toContain(userAId);
    expect(ids).not.toContain(userBId);
  });

  it('hors transaction en tant que ensemb_app (aucun set_config) → RLS bloque toutes les lignes', async () => {
    // SET ROLE hors transaction : s'applique à la connexion courante jusqu'au RESET ROLE.
    // Sans set_config, current_setting retourne NULL → policy rejette toutes les lignes.
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET ROLE ensemb_app');
      const result = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users`;
      await tx.$executeRawUnsafe('RESET ROLE');
      return result;
    });
    expect(rows).toHaveLength(0);
  });

  it('dans une transaction ensemb_app avec set_config(orgB) → ne voit que les users de orgB', async () => {
    const users = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET ROLE ensemb_app');
      await setTenant(tx, orgBId);
      const result = await tx.user.findMany();
      await tx.$executeRawUnsafe('RESET ROLE');
      return result;
    });

    const ids = users.map((u) => u.id);
    expect(ids).toContain(userBId);
    expect(ids).not.toContain(userAId);
  });

  it('set_config(is_local=true) ne fuit pas hors de la transaction — connexion pool propre', async () => {
    // Étape 1 : transaction orgA avec SET ROLE + set_config.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET ROLE ensemb_app');
      await setTenant(tx, orgAId);
      const users = await tx.user.findMany();
      expect(users.map((u) => u.id)).toContain(userAId);
      await tx.$executeRawUnsafe('RESET ROLE');
    }); // Commit → is_local=true efface app.current_tenant sur cette connexion.

    // Étape 2 : même connexion potentiellement réutilisée, sans set_config.
    // Si la variable avait fuité (SET sans is_local), on verrait les users de orgA.
    const rowsAfterCommit = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET ROLE ensemb_app');
      const result = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users`;
      await tx.$executeRawUnsafe('RESET ROLE');
      return result;
    });
    expect(rowsAfterCommit).toHaveLength(0);
  });
});
