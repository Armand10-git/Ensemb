/**
 * Tests d'intégration ProductWarehouse (S15).
 *
 * Couvre :
 *  - Init stock (idempotent) via POST /api/v1/inventory/stock/init
 *  - Lecture stock par produit via GET /api/v1/inventory/stock/product/:id
 *  - Lecture stock par entrepôt via GET /api/v1/inventory/stock/warehouse/:id
 *  - Isolation multi-tenant : stock d'un tenant invisible par un autre
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
import { InventoryModule } from '../src/modules/inventory/inventory.module';

jest.setTimeout(30_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-inv-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-inv-b-${SUFFIX}`;

let app: INestApplication;
let prisma: PrismaClient;
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let productAId: string;
let warehouseAId: string;

const INVENTORY_PERMS = ['adjustments.view', 'adjustments.create'];

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  const orgA = await prisma.organization.create({ data: { name: 'E2E Inv Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Inv Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  for (const name of INVENTORY_PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const perms = await prisma.permission.findMany({
    where: { name: { in: INVENTORY_PERMS } },
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

  await setupOrgUser(orgAId, `inv-a-${SUFFIX}@e2e.cm`);
  await setupOrgUser(orgBId, `inv-b-${SUFFIX}@e2e.cm`);

  // Données de base pour le test : catégorie + produit + entrepôt dans org A
  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CATA-${SUFFIX}`, name: 'Cat A' },
  });

  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-${SUFFIX}`,
      name: 'Produit Test A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      stockAlert: 0,
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `Entrepôt A-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

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
      InventoryModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  const loginA = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgAId)
    .send({ email: `inv-a-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenA = loginA.body.accessToken as string;

  const loginB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgBId)
    .send({ email: `inv-b-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenB = loginB.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();
  await prisma.productWarehouse.deleteMany({ where: { product: { organizationId: orgAId } } });
  await prisma.product.deleteMany({ where: { organizationId: orgAId } });
  await prisma.category.deleteMany({ where: { organizationId: orgAId } });
  await prisma.warehouse.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.$disconnect();
});

// ─── POST /inventory/stock/init ──────────────────────────────────────────────

describe('POST /api/v1/inventory/stock/init', () => {
  it('200 — initialise le stock à 0 (quantity=0, version=0)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/stock/init')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ productId: productAId, warehouseId: warehouseAId });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      productId: productAId,
      warehouseId: warehouseAId,
      version: 0,
    });
    expect(parseFloat(res.body.quantity as string)).toBe(0);
  });

  it('200 — idempotent : second appel retourne le même enregistrement', async () => {
    const res1 = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/stock/init')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ productId: productAId, warehouseId: warehouseAId });

    const res2 = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/stock/init')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ productId: productAId, warehouseId: warehouseAId });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.id).toBe(res2.body.id);
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/stock/init')
      .send({ productId: productAId, warehouseId: warehouseAId });

    expect(res.status).toBe(401);
  });

  it('400 — payload invalide (UUIDs manquants)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/stock/init')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ productId: 'pas-un-uuid' });

    expect(res.status).toBe(400);
  });
});

// ─── GET /inventory/stock/product/:productId ─────────────────────────────────

describe('GET /api/v1/inventory/stock/product/:productId', () => {
  it('200 — retourne les stocks du produit par entrepôt', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/inventory/stock/product/${productAId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toMatchObject({ productId: productAId });
  });

  it('isolation — tenant B ne peut pas voir le stock du produit de tenant A', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/inventory/stock/product/${productAId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    // ForbiddenException (403) car produit n'appartient pas à org B
    expect(res.status).toBe(403);
  });
});

// ─── GET /inventory/stock/warehouse/:warehouseId ─────────────────────────────

describe('GET /api/v1/inventory/stock/warehouse/:warehouseId', () => {
  it("200 — retourne le stock paginé de l'entrepôt", async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/inventory/stock/warehouse/${warehouseAId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: expect.any(Array), total: expect.any(Number) });
  });

  it("isolation — tenant B ne peut pas voir le stock de l'entrepôt de tenant A", async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/inventory/stock/warehouse/${warehouseAId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
  });
});
