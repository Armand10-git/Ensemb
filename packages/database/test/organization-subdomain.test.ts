import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Test d'intégration — contrainte d'unicité du sous-domaine Organization.
 * Requiert une Postgres accessible via DATABASE_URL.
 */

const prisma = new PrismaClient();

const BASE_SUBDOMAIN = `test-org-${Date.now()}`;

afterAll(async () => {
  await prisma.organization.deleteMany({
    where: { subdomain: { startsWith: 'test-org-' } },
  });
  await prisma.$disconnect();
});

describe('Organization — contrainte subdomain unique', () => {
  it('crée une organisation avec un sous-domaine valide', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Boutique Test', subdomain: BASE_SUBDOMAIN },
    });

    expect(org.id).toBeDefined();
    expect(org.subdomain).toBe(BASE_SUBDOMAIN);
    expect(org.status).toBe('TRIALING');
  });

  it('rejette un doublon de sous-domaine', async () => {
    await expect(
      prisma.organization.create({
        data: { name: 'Doublon', subdomain: BASE_SUBDOMAIN },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it('accepte un sous-domaine différent', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Autre boutique', subdomain: `${BASE_SUBDOMAIN}-2` },
    });

    expect(org.subdomain).toBe(`${BASE_SUBDOMAIN}-2`);
  });
});
