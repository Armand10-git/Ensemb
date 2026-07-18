import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Tests d'intégration — modèles User, Role, Permission, RoleOnUser, PermissionOnRole.
 * Requiert une Postgres accessible via DATABASE_URL.
 */

const prisma = new PrismaClient();

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `test-s04-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `test-s04-b-${SUFFIX}`;

let orgAId: string;
let orgBId: string;

beforeAll(async () => {
  const [orgA, orgB] = await Promise.all([
    prisma.organization.create({ data: { name: 'Org A S04', subdomain: ORG_A_SUBDOMAIN } }),
    prisma.organization.create({ data: { name: 'Org B S04', subdomain: ORG_B_SUBDOMAIN } }),
  ]);
  orgAId = orgA.id;
  orgBId = orgB.id;
});

afterAll(async () => {
  // Suppression dans l'ordre inverse des FK
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permission.deleteMany({ where: { name: { startsWith: 'test.s04.' } } });
  await prisma.organization.deleteMany({ where: { subdomain: { startsWith: 'test-s04-' } } });
  await prisma.$disconnect();
});

describe('User + Role + RoleOnUser — création et assignation', () => {
  it('crée un utilisateur, un rôle et les relie via RoleOnUser', async () => {
    const permission = await prisma.permission.create({
      data: { name: 'test.s04.invoices.create', label: 'Créer une facture' },
    });

    const role = await prisma.role.create({
      data: {
        organizationId: orgAId,
        name: 'Vendeur',
        permissions: { create: { permissionId: permission.id } },
      },
    });

    const user = await prisma.user.create({
      data: {
        organizationId: orgAId,
        firstname: 'Alice',
        lastname: 'Durand',
        email: 'alice@exemple.cm',
        username: 'alice',
        password: '$2b$10$hashedpassword',
        roles: { create: { roleId: role.id } },
      },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });

    expect(user.id).toBeDefined();
    expect(user.roles).toHaveLength(1);
    expect(user.roles[0]!.role.name).toBe('Vendeur');
    expect(user.roles[0]!.role.permissions[0]!.permission.name).toBe('test.s04.invoices.create');
  });
});

describe('User — contrainte unique composite (organizationId, email)', () => {
  it('accepte le même email dans deux organisations différentes', async () => {
    await prisma.user.create({
      data: {
        organizationId: orgAId,
        firstname: 'Bob',
        lastname: 'Martin',
        email: 'bob@exemple.cm',
        username: 'bob-a',
        password: '$2b$10$hashedpassword',
      },
    });

    const userB = await prisma.user.create({
      data: {
        organizationId: orgBId,
        firstname: 'Bob',
        lastname: 'Martin',
        email: 'bob@exemple.cm',
        username: 'bob-b',
        password: '$2b$10$hashedpassword',
      },
    });

    expect(userB.id).toBeDefined();
    expect(userB.organizationId).toBe(orgBId);
  });

  it('rejette le même email dans la même organisation', async () => {
    await prisma.user.create({
      data: {
        organizationId: orgAId,
        firstname: 'Carol',
        lastname: 'Smith',
        email: 'carol@exemple.cm',
        username: 'carol',
        password: '$2b$10$hashedpassword',
      },
    });

    await expect(
      prisma.user.create({
        data: {
          organizationId: orgAId,
          firstname: 'Carol',
          lastname: 'Dupont',
          email: 'carol@exemple.cm',
          username: 'carol2',
          password: '$2b$10$hashedpassword',
        },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });
});
