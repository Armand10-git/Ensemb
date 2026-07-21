/**
 * Tests d'intégration Adjustment (S16).
 *
 * Couvre :
 *  - Création d'un ajustement DRAFT
 *  - Validation : ProductWarehouse.quantity incrémentée/décrémentée en base
 *  - Validation d'un ADDITION de 5 + SOUSTRACTION de 3 → net +2
 *  - Re-validation d'un ajustement déjà VALIDATED → 400
 *  - Isolation multi-tenant
 *  - Suppression DRAFT → 204 ; VALIDATED → 400
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { RedisModule } from '../src/common/redis.module';
import { DocumentCounterModule } from '../src/common/document-counter.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { RealtimeModule } from '../src/modules/realtime/realtime.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-adj-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-adj-b-${SUFFIX}`;

let app: INestApplication;
let prisma: PrismaClient;
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let productAId: string;
let warehouseAId: string;
let pwAId: string; // ProductWarehouse id

const PERMS = ['adjustments.view', 'adjustments.create', 'adjustments.validate', 'adjustments.delete'];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  const orgA = await prisma.organization.create({ data: { name: 'E2E Adj Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Adj Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  for (const name of PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const perms = await prisma.permission.findMany({
    where: { name: { in: PERMS } },
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
        lastname: 'Adj',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
  }

  await setupOrgUser(orgAId, `adj-a-${SUFFIX}@e2e.cm`);
  await setupOrgUser(orgBId, `adj-b-${SUFFIX}@e2e.cm`);

  // Données de base pour org A : catégorie, produit, entrepôt, stock initialisé
  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CATA-${SUFFIX}`, name: 'Cat Adj A' },
  });

  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-ADJ-${SUFFIX}`,
      name: 'Produit Ajustement A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      stockAlert: 5,
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `Entrepôt Adj A-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  // Initialiser le stock à 10 pièces
  const pw = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('10'), version: 0 },
  });
  pwAId = pw.id;

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
      PassportModule,
      JwtModule.register({}),
      PrismaModule,
      EncryptionModule,
      RedisModule,
      DocumentCounterModule,
      AuditModule,
      AuthModule,
      RealtimeModule,
      InventoryModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  const loginA = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgAId)
    .send({ email: `adj-a-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenA = loginA.body.accessToken as string;

  const loginB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgBId)
    .send({ email: `adj-b-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenB = loginB.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();
  // Ordre de nettoyage : lignes → en-têtes → stock → variantes → produits → entrepôts → users → roles → orgs
  await prisma.adjustmentDetail.deleteMany({ where: { adjustment: { organizationId: orgAId } } });
  await prisma.adjustment.deleteMany({ where: { organizationId: orgAId } });
  await prisma.productWarehouse.deleteMany({ where: { warehouseId: warehouseAId } });
  await prisma.product.deleteMany({ where: { organizationId: orgAId } });
  await prisma.category.deleteMany({ where: { organizationId: orgAId } });
  await prisma.warehouse.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.documentCounter.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.$disconnect();
});

// ─── POST /inventory/adjustments ─────────────────────────────────────────────

describe('POST /api/v1/inventory/adjustments', () => {
  it('201 — crée un ajustement DRAFT avec référence', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        warehouseId: warehouseAId,
        date: '2026-07-21T00:00:00.000Z',
        note: 'Inventaire mensuel',
        details: [{ productId: productAId, type: 'ADDITION', quantity: '5' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.reference).toMatch(/^AJT-\d{4}-\d+$/);
    expect(res.body.details).toHaveLength(1);
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .send({ warehouseId: warehouseAId, date: '2026-07-21T00:00:00.000Z', details: [] });

    expect(res.status).toBe(401);
  });

  it('422 — payload invalide (details vide)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ warehouseId: warehouseAId, date: '2026-07-21T00:00:00.000Z', details: [] });

    expect(res.status).toBe(422);
  });

  it('isolation — tenant B ne peut pas utiliser le warehouseId de tenant A', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        warehouseId: warehouseAId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, type: 'ADDITION', quantity: '5' }],
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── PATCH /inventory/adjustments/:id/validate ───────────────────────────────

describe('PATCH /api/v1/inventory/adjustments/:id/validate', () => {
  let draftId: string;

  beforeEach(async () => {
    // Créer un ajustement DRAFT frais pour chaque test
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        warehouseId: warehouseAId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, type: 'ADDITION', quantity: '2' }],
      });
    draftId = res.body.id as string;
  });

  it('200 — valide et incrémente ProductWarehouse.quantity en base', async () => {
    const before = await prisma.productWarehouse.findUnique({ where: { id: pwAId }, select: { quantity: true } });

    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/adjustments/${draftId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VALIDATED');

    const after = await prisma.productWarehouse.findUnique({ where: { id: pwAId }, select: { quantity: true } });
    const diff = new Decimal(after!.quantity).minus(new Decimal(before!.quantity));
    expect(diff.toString()).toBe('2');
  });

  it('400 — re-valider un ajustement déjà VALIDATED', async () => {
    // Valider une première fois
    await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/adjustments/${draftId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    // Re-valider → 400
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/adjustments/${draftId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    expect(res.status).toBe(400);
  });
});

describe('ADDITION + SOUSTRACTION combinées — net +2', () => {
  it('200 — ADDITION 5 + SOUSTRACTION 3 → net +2 en base', async () => {
    const before = await prisma.productWarehouse.findUnique({ where: { id: pwAId }, select: { quantity: true, version: true } });

    const createRes = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        warehouseId: warehouseAId,
        date: '2026-07-21T00:00:00.000Z',
        details: [
          { productId: productAId, type: 'ADDITION',    quantity: '5' },
          { productId: productAId, type: 'SOUSTRACTION', quantity: '3' },
        ],
      });

    expect(createRes.status).toBe(201);

    const valRes = await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/adjustments/${createRes.body.id as string}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    expect(valRes.status).toBe(200);

    const after = await prisma.productWarehouse.findUnique({ where: { id: pwAId }, select: { quantity: true } });
    const diff = new Decimal(after!.quantity).minus(new Decimal(before!.quantity));
    expect(diff.toString()).toBe('2');
  });
});

// ─── DELETE /inventory/adjustments/:id ───────────────────────────────────────

describe('DELETE /api/v1/inventory/adjustments/:id', () => {
  it('204 — supprime un ajustement DRAFT', async () => {
    const createRes = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        warehouseId: warehouseAId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, type: 'ADDITION', quantity: '1' }],
      });
    const adjId = createRes.body.id as string;

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/inventory/adjustments/${adjId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(204);
  });

  it('400 — supprime un ajustement VALIDATED → interdit', async () => {
    const createRes = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        warehouseId: warehouseAId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, type: 'ADDITION', quantity: '1' }],
      });
    const adjId = createRes.body.id as string;

    await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/adjustments/${adjId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/inventory/adjustments/${adjId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(400);
  });
});

// ─── Isolation multi-tenant ───────────────────────────────────────────────────

describe('GET /api/v1/inventory/adjustments — isolation', () => {
  it('tenant B ne voit pas les ajustements de tenant A', async () => {
    // Créer un ajustement pour org A
    await supertest(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        warehouseId: warehouseAId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, type: 'ADDITION', quantity: '1' }],
      });

    // Org B ne doit pas en voir
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    const data = res.body.data as { organizationId: string }[];
    expect(data.every((a) => a.organizationId !== orgAId)).toBe(true);
  });
});
