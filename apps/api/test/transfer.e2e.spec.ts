/**
 * Tests d'intégration StockTransfer (S17).
 *
 * Couvre :
 *  - Création d'un transfert DRAFT (POST → 201)
 *  - Validation : ProductWarehouse source décrémentée, destination incrémentée en base
 *  - ADDITION 5 : source passe de 10 à 5, destination de 0 à 5
 *  - Rollback si le ProductWarehouse destination est introuvable → 404, source inchangée
 *  - Re-valider un VALIDATED → 400
 *  - Isolation multi-tenant
 *  - DELETE DRAFT → 204 ; DELETE VALIDATED → 400
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
const ORG_A_SUBDOMAIN = `e2e-trf-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-trf-b-${SUFFIX}`;

let app: INestApplication;
let prisma: PrismaClient;
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let productAId: string;
let whFromId: string;   // Entrepôt source
let whToId: string;     // Entrepôt destination
let pwFromId: string;   // ProductWarehouse source
let pwToId: string;     // ProductWarehouse destination

const PERMS = [
  'transfers.view',
  'transfers.create',
  'transfers.validate',
  'transfers.delete',
];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  const orgA = await prisma.organization.create({ data: { name: 'E2E Trf Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Trf Org B', subdomain: ORG_B_SUBDOMAIN } });
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
        lastname: 'Trf',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
  }

  await setupOrgUser(orgAId, `trf-a-${SUFFIX}@e2e.cm`);
  await setupOrgUser(orgBId, `trf-b-${SUFFIX}@e2e.cm`);

  // Données de base pour org A
  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-TRF-${SUFFIX}`, name: 'Cat Trf A' },
  });

  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-TRF-${SUFFIX}`,
      name: 'Produit Transfert A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      stockAlert: 3,
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whFrom = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH Source-${SUFFIX}`, isDefault: true },
  });
  const whTo = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH Dest-${SUFFIX}` },
  });
  whFromId = whFrom.id;
  whToId   = whTo.id;

  // Stock source = 10, stock destination = 0
  const pwFrom = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: whFromId, quantity: new Decimal('10'), version: 0 },
  });
  const pwTo = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: whToId, quantity: new Decimal('0'), version: 0 },
  });
  pwFromId = pwFrom.id;
  pwToId   = pwTo.id;

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
    .send({ email: `trf-a-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenA = loginA.body.accessToken as string;

  const loginB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgBId)
    .send({ email: `trf-b-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenB = loginB.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();
  // Nettoyage dans l'ordre des FK
  await prisma.stockTransferDetail.deleteMany({ where: { transfer: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.stockTransfer.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.productWarehouse.deleteMany({ where: { warehouseId: { in: [whFromId, whToId] } } });
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

// ─── POST /inventory/transfers ────────────────────────────────────────────────

describe('POST /api/v1/inventory/transfers', () => {
  it('201 — crée un transfert DRAFT avec référence', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whToId,
        date: '2026-07-21T00:00:00.000Z',
        note: 'Test transfert',
        details: [{ productId: productAId, quantity: '2' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.reference).toMatch(/^TRF-\d{4}-\d+$/);
    expect(res.body.details).toHaveLength(1);
  });

  it('400 — fromWarehouseId === toWarehouseId', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whFromId, // même entrepôt
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, quantity: '2' }],
      });

    expect(res.status).toBe(400);
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .send({});

    expect(res.status).toBe(401);
  });

  it('422 — payload invalide (details vide)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ fromWarehouseId: whFromId, toWarehouseId: whToId, date: '2026-07-21T00:00:00.000Z', details: [] });

    expect(res.status).toBe(422);
  });

  it('isolation — tenant B ne peut pas utiliser les entrepôts de tenant A', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whToId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, quantity: '2' }],
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── PATCH /inventory/transfers/:id/validate ─────────────────────────────────

describe('PATCH /api/v1/inventory/transfers/:id/validate', () => {
  it('200 — ADDITION 5 : source passe de 10 à 5, destination de 0 à 5', async () => {
    // Remettre le stock à l'état initial pour ce test (les tests précédents ont pu le modifier)
    await prisma.productWarehouse.update({
      where: { id: pwFromId },
      data: { quantity: new Decimal('10'), version: 0 },
    });
    await prisma.productWarehouse.update({
      where: { id: pwToId },
      data: { quantity: new Decimal('0'), version: 0 },
    });

    const createRes = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whToId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, quantity: '5' }],
      });
    const draftId = createRes.body.id as string;

    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/transfers/${draftId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VALIDATED');

    const pwFrom = await prisma.productWarehouse.findUnique({ where: { id: pwFromId }, select: { quantity: true } });
    const pwTo   = await prisma.productWarehouse.findUnique({ where: { id: pwToId   }, select: { quantity: true } });

    expect(new Decimal(pwFrom!.quantity).toString()).toBe('5');
    expect(new Decimal(pwTo!.quantity).toString()).toBe('5');
  });

  it('404 + rollback — le stock destination est absent → source inchangée', async () => {
    // Remettre le stock source à 10
    await prisma.productWarehouse.update({
      where: { id: pwFromId },
      data: { quantity: new Decimal('10'), version: 0 },
    });

    // Créer un produit sans ProductWarehouse dans whTo pour simuler l'absence
    const catTmp = await prisma.category.create({
      data: { organizationId: orgAId, code: `CAT-ROLL-${SUFFIX}`, name: 'Cat Rollback' },
    });
    const prodMissing = await prisma.product.create({
      data: {
        organizationId: orgAId,
        code: `PROD-MISS-${SUFFIX}`,
        name: 'Produit sans stock dest',
        cost: '100',
        price: '150',
        taxRate: '0',
        taxMethod: 'percentage',
        stockAlert: 0,
        categoryId: catTmp.id,
      },
    });
    // Stock source initialisé, mais PAS de stock destination
    await prisma.productWarehouse.create({
      data: { productId: prodMissing.id, warehouseId: whFromId, quantity: new Decimal('10'), version: 0 },
    });

    const createRes = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whToId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: prodMissing.id, quantity: '3' }],
      });
    const draftId = createRes.body.id as string;

    const quantityBefore = await prisma.productWarehouse.findFirst({
      where: { productId: prodMissing.id, warehouseId: whFromId },
      select: { quantity: true },
    });

    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/transfers/${draftId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    // Doit échouer avec 404 (stock destination introuvable)
    expect(res.status).toBe(404);

    // La source doit rester inchangée (rollback de la transaction)
    const quantityAfter = await prisma.productWarehouse.findFirst({
      where: { productId: prodMissing.id, warehouseId: whFromId },
      select: { quantity: true },
    });
    expect(new Decimal(quantityAfter!.quantity).toString())
      .toBe(new Decimal(quantityBefore!.quantity).toString());

    // Nettoyage du produit temporaire (l'ordre FK : details → transfer → stock → product → catégorie)
    await prisma.stockTransferDetail.deleteMany({ where: { transferId: draftId } });
    await prisma.stockTransfer.delete({ where: { id: draftId } });
    await prisma.productWarehouse.deleteMany({ where: { productId: prodMissing.id } });
    await prisma.product.delete({ where: { id: prodMissing.id } });
    await prisma.category.delete({ where: { id: catTmp.id } });
  });

  it('400 — re-valider un transfert déjà VALIDATED', async () => {
    // Remettre les stocks à un état cohérent
    await prisma.productWarehouse.update({
      where: { id: pwFromId },
      data: { quantity: new Decimal('10'), version: 0 },
    });
    await prisma.productWarehouse.update({
      where: { id: pwToId },
      data: { quantity: new Decimal('0'), version: 0 },
    });

    const createRes = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whToId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, quantity: '1' }],
      });
    const draftId = createRes.body.id as string;

    // Valider une première fois
    await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/transfers/${draftId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    // Re-valider → 400
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/transfers/${draftId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    expect(res.status).toBe(400);
  });
});

// ─── GET /inventory/transfers — isolation ─────────────────────────────────────

describe('GET /api/v1/inventory/transfers — isolation', () => {
  it('tenant B ne voit pas les transferts de tenant A', async () => {
    // Créer un transfert pour org A
    await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whToId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, quantity: '1' }],
      });

    // Org B ne doit pas en voir
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    const data = res.body.data as { organizationId: string }[];
    expect(data.every((t) => t.organizationId !== orgAId)).toBe(true);
  });
});

// ─── DELETE /inventory/transfers/:id ─────────────────────────────────────────

describe('DELETE /api/v1/inventory/transfers/:id', () => {
  it('204 — supprime un transfert DRAFT', async () => {
    const createRes = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whToId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, quantity: '1' }],
      });
    const trfId = createRes.body.id as string;

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/inventory/transfers/${trfId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(204);
  });

  it('400 — supprime un transfert VALIDATED → interdit', async () => {
    // Remettre les stocks à un état cohérent
    await prisma.productWarehouse.update({
      where: { id: pwFromId },
      data: { quantity: new Decimal('10'), version: 0 },
    });
    await prisma.productWarehouse.update({
      where: { id: pwToId },
      data: { quantity: new Decimal('0'), version: 0 },
    });

    const createRes = await supertest(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        fromWarehouseId: whFromId,
        toWarehouseId: whToId,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: productAId, quantity: '1' }],
      });
    const trfId = createRes.body.id as string;

    // Valider d'abord
    await supertest(app.getHttpServer())
      .patch(`/api/v1/inventory/transfers/${trfId}/validate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send();

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/inventory/transfers/${trfId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(400);
  });
});
