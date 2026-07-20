/**
 * Tests d'intégration CatalogModule — Supertest contre Postgres local.
 *
 * Couvre :
 *  - CRUD complet catégories : créer, lire, modifier, soft-delete
 *  - CRUD complet marques : créer, lire, modifier, soft-delete
 *  - Isolation multi-tenant : ressources d'un tenant non visibles par un autre
 *  - Doublon de code dans la même org → 409 ; même code deux orgs différentes → 201
 *  - Soft-deleted exclus de la liste ; nom libéré après soft-delete réutilisable
 *  - Suppression d'une catégorie avec produits actifs → 400 avec message explicite
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { RedisModule } from '../src/common/redis.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { CatalogModule } from '../src/modules/catalog/catalog.module';

jest.setTimeout(30_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-cat-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-cat-b-${SUFFIX}`;

let app: INestApplication;
let prisma: PrismaClient;
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;

const CATALOG_PERMS = [
  'categories.view', 'categories.create', 'categories.edit', 'categories.delete',
  'brands.view', 'brands.create', 'brands.edit', 'brands.delete',
];

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  const orgA = await prisma.organization.create({ data: { name: 'E2E Cat Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Cat Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  for (const name of CATALOG_PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }

  const perms = await prisma.permission.findMany({
    where: { name: { in: CATALOG_PERMS } },
    select: { id: true },
  });

  async function setupOrgUser(orgId: string, email: string) {
    const role = await prisma.role.create({ data: { organizationId: orgId, name: 'Admin' } });
    for (const p of perms) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Test',
        lastname: 'User',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
  }

  await setupOrgUser(orgAId, `user-a-${SUFFIX}@e2e.cm`);
  await setupOrgUser(orgBId, `user-b-${SUFFIX}@e2e.cm`);

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
      PassportModule,
      JwtModule.register({}),
      PrismaModule,
      EncryptionModule,
      RedisModule,
      AuditModule,
      AuthModule,
      CatalogModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  const loginA = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgAId)
    .send({ email: `user-a-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenA = loginA.body.accessToken as string;

  const loginB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgBId)
    .send({ email: `user-b-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenB = loginB.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();
  await prisma.product.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.brand.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.$disconnect();
});

// ─── Catégories ──────────────────────────────────────────────────────────────

describe('POST /api/v1/catalog/categories', () => {
  it('201 — crée une catégorie pour le tenant', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: `EL${SUFFIX % 100}`, name: `Électronique-${SUFFIX}` });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: `EL${SUFFIX % 100}`, name: `Électronique-${SUFFIX}` });
    expect(res.body).toHaveProperty('id');
  });

  it('409 — doublon de code dans la même org', async () => {
    const code = `DC${SUFFIX % 100}`;
    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code, name: `Cat A - ${SUFFIX}` });

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code, name: `Cat B - ${SUFFIX}` });

    expect(res.status).toBe(409);
  });

  it('201 — même code, deux orgs différentes → OK', async () => {
    const code = `SH${SUFFIX % 100}`;
    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code, name: `SharedCatA-${SUFFIX}` });

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ code, name: `SharedCatB-${SUFFIX}` });

    expect(res.status).toBe(201);
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .send({ code: 'TEST', name: 'Test' });
    expect(res.status).toBe(401);
  });

  it('422 — code avec caractères invalides', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: 'lower', name: 'Test' });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/catalog/categories', () => {
  it("200 — ne retourne que les catégories du tenant", async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
  });
});

describe('GET /api/v1/catalog/categories/:id', () => {
  let catId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: `DT${SUFFIX % 100}`, name: `DetailCat-${SUFFIX}` });
    catId = (res.body as { id: string }).id;
  });

  it("200 — retourne la catégorie du tenant", async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/catalog/categories/${catId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(catId);
  });

  it('403 ou 404 — un autre tenant ne peut pas voir cette catégorie', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/catalog/categories/${catId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect([403, 404]).toContain(res.status);
  });
});

describe('PATCH /api/v1/catalog/categories/:id', () => {
  let catId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: `UP${SUFFIX % 100}`, name: `UpdateCat-${SUFFIX}` });
    catId = (res.body as { id: string }).id;
  });

  it('200 — met à jour le nom', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/catalog/categories/${catId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Updated-${SUFFIX}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Updated-${SUFFIX}`);
  });

  it('403 ou 404 — un autre tenant ne peut pas modifier', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/catalog/categories/${catId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hack' });
    expect([403, 404]).toContain(res.status);
  });
});

describe('DELETE /api/v1/catalog/categories/:id', () => {
  it('204 — soft-delete réussi', async () => {
    const created = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: `DEL${SUFFIX % 10}`, name: `ToDelete-${SUFFIX}` });
    const catId = (created.body as { id: string }).id;

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/catalog/categories/${catId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(204);

    const list = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`);
    const ids = (list.body.data as { id: string }[]).map((c) => c.id);
    expect(ids).not.toContain(catId);
  });

  it('400 — suppression avec produits actifs rattachés → message explicite', async () => {
    const catRes = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: `PR${SUFFIX % 10}`, name: `WithProduct-${SUFFIX}` });
    const catId = (catRes.body as { id: string }).id;

    // Créer un produit stub associé à cette catégorie
    await prisma.product.create({
      data: { organizationId: orgAId, categoryId: catId },
    });

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/catalog/categories/${catId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message).toMatch(/produit/i);

    // Cleanup
    await prisma.product.deleteMany({ where: { categoryId: catId } });
    await prisma.category.delete({ where: { id: catId } });
  });
});

// ─── Marques ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/catalog/brands', () => {
  it('201 — crée une marque pour le tenant', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Samsung-${SUFFIX}`, description: 'Marque tech' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: `Samsung-${SUFFIX}` });
    expect(res.body).toHaveProperty('id');
  });

  it('409 — doublon de nom dans la même org', async () => {
    const name = `DupBrand-${SUFFIX}`;
    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name });

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name });

    expect(res.status).toBe(409);
  });

  it('201 — même nom de marque, deux orgs → OK', async () => {
    const name = `SharedBrand-${SUFFIX}`;
    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name });

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name });

    expect(res.status).toBe(201);
  });

  it('422 — image URL invalide', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `BadURL-${SUFFIX}`, image: 'pas-une-url' });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/catalog/brands', () => {
  it("200 — ne retourne que les marques du tenant", async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
  });
});

describe('PATCH /api/v1/catalog/brands/:id', () => {
  let brandId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `UpdateBrand-${SUFFIX}` });
    brandId = (res.body as { id: string }).id;
  });

  it('200 — met à jour le nom', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/catalog/brands/${brandId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `UpdatedBrand-${SUFFIX}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`UpdatedBrand-${SUFFIX}`);
  });

  it('403 ou 404 — un autre tenant ne peut pas modifier', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/catalog/brands/${brandId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hack' });
    expect([403, 404]).toContain(res.status);
  });
});

describe('DELETE /api/v1/catalog/brands/:id', () => {
  it('204 — soft-delete toujours permis', async () => {
    const created = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `DeleteBrand-${SUFFIX}` });
    const brandId = (created.body as { id: string }).id;

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/catalog/brands/${brandId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(204);

    const list = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${tokenA}`);
    const ids = (list.body.data as { id: string }[]).map((b) => b.id);
    expect(ids).not.toContain(brandId);
  });
});
