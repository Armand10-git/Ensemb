/**
 * Tests d'intégration PaymentReturn (S26 — §18.5, mirror du patron payment-sale.e2e.spec.ts).
 *
 * Couvre :
 *  - POST /sale-returns/:id/payments et /purchase-returns/:id/payments : 201, référence REM-…,
 *    recalcul paidAmount/paymentStatus du retour parent (sur un retour COMPLETED, grandTotal > 0)
 *  - 400 — montant dépassant le solde restant
 *  - PATCH/DELETE payments/:id — recalcul du parent, y compris redescente PAID → PARTIAL → UNPAID
 *  - Isolation tenant
 *  - VÉRIFICATION DE LA CONTRAINTE CHECK SQL EN BASE (défense en profondeur, indépendante de
 *    l'application) : insertion SQL brute avec les deux FK non-null, puis avec les deux FK
 *    null — dans les deux cas Postgres doit rejeter via
 *    payment_returns_exactly_one_parent_chk.
 *
 * Seul ReturnsModule est importé (avec les modules d'infra communs) — Sale/Purchase d'origine
 * créés directement via prisma.sale.create/prisma.saleDetail.create (resp. purchase/detail),
 * SaleReturn/PurchaseReturn créés et validés via les endpoints HTTP de ReturnsModule.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Decimal } from '@prisma/client/runtime/library';
import { getTestPrisma } from './helpers/prisma';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { RedisModule } from '../src/common/redis.module';
import { DocumentCounterModule } from '../src/common/document-counter.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { RealtimeModule } from '../src/modules/realtime/realtime.module';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { ReturnsModule } from '../src/modules/returns/returns.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-payret-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-payret-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let adminAId: string;
let clientAId: string;
let providerAId: string;
let warehouseAId: string;
let productAId: string;

const PERMS = [
  'saleReturns.view', 'saleReturns.create', 'saleReturns.validate',
  'purchaseReturns.view', 'purchaseReturns.create', 'purchaseReturns.validate',
  'paymentReturns.view', 'paymentReturns.create', 'paymentReturns.edit', 'paymentReturns.delete',
  'records.viewAll',
];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E PaymentReturn Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E PaymentReturn Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  for (const name of PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const permIds = await prisma.permission.findMany({ where: { name: { in: PERMS } }, select: { id: true } });

  async function setupUser(orgId: string, email: string, roleName: string): Promise<string> {
    const role = await prisma.role.create({ data: { organizationId: orgId, name: roleName } });
    for (const p of permIds) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Test',
        lastname: 'PaymentReturn',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  adminAId = await setupUser(orgAId, `payret-a-${SUFFIX}@e2e.cm`, 'Admin');
  await setupUser(orgBId, `payret-b-${SUFFIX}@e2e.cm`, 'Admin');

  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-PAYRET-${SUFFIX}`, name: 'Cat PaymentReturn A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-PAYRET-${SUFFIX}`,
      name: 'Produit PaymentReturn A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH PaymentReturn-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  const clientA = await prisma.client.create({
    data: { organizationId: orgAId, name: `Client PaymentReturn ${SUFFIX}`, code: 1 },
  });
  clientAId = clientA.id;

  const providerA = await prisma.provider.create({
    data: { organizationId: orgAId, name: `Fournisseur PaymentReturn ${SUFFIX}`, code: 1 },
  });
  providerAId = providerA.id;

  // Stock généreux — suffisant pour absorber les décréments des retours fournisseurs testés ici.
  await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('1000'), version: 0 },
  });

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
      BullModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: { url: config.get<string>('REDIS_URL') ?? 'redis://localhost:6380' },
        }),
      }),
      PassportModule,
      JwtModule.register({}),
      PrismaModule,
      EncryptionModule,
      RedisModule,
      DocumentCounterModule,
      AuditModule,
      AuthModule,
      TenancyModule,
      RealtimeModule,
      ReturnsModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  async function login(orgId: string, email: string): Promise<string> {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ email, password: 'TestPass!1' });
    return res.body.accessToken as string;
  }

  tokenA = await login(orgAId, `payret-a-${SUFFIX}@e2e.cm`);
  tokenB = await login(orgBId, `payret-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  await prisma.paymentReturn.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.saleReturnDetail.deleteMany({ where: { saleReturn: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.saleReturn.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.purchaseReturnDetail.deleteMany({ where: { purchaseReturn: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.purchaseReturn.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.saleDetail.deleteMany({ where: { sale: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.sale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.purchaseDetail.deleteMany({ where: { purchase: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.purchase.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.client.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.provider.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.productWarehouse.deleteMany({ where: { productId: productAId } });
  await prisma.product.deleteMany({ where: { organizationId: orgAId } });
  await prisma.category.deleteMany({ where: { organizationId: orgAId } });
  await prisma.warehouse.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.documentCounter.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
});

// ─── Helpers requête authentifiée ──────────────────────────────────────────────

function asA(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenA}`)
    .set('X-Organization-Id', orgAId);
}
function asB(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenB}`)
    .set('X-Organization-Id', orgBId);
}

/** Crée une vente COMPLETED (hors HTTP) puis un SaleReturn COMPLETED (via HTTP) — grandTotal = price × quantity. */
async function createValidatedSaleReturn(price: string, quantity: string): Promise<{ id: string; grandTotal: string }> {
  const total = new Decimal(price).times(quantity);
  const sale = await prisma.sale.create({
    data: {
      organizationId: orgAId,
      reference: `TST-SALE-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: new Date('2026-07-26'),
      userId: adminAId,
      clientId: clientAId,
      warehouseId: warehouseAId,
      grandTotal: total,
      status: 'COMPLETED',
    },
  });
  const detail = await prisma.saleDetail.create({
    data: {
      saleId: sale.id,
      productId: productAId,
      price: new Decimal(price),
      taxAmount: new Decimal('0'),
      taxMethod: 'percentage',
      discount: new Decimal('0'),
      discountMethod: 'percentage',
      quantity: new Decimal(quantity),
      total,
    },
  });

  const created = await asA('post', '/api/v1/sale-returns').send({
    saleId: sale.id,
    date: '2026-07-27T00:00:00.000Z',
    details: [{ saleDetailId: detail.id, quantity }],
  });
  expect(created.status).toBe(201);
  const validated = await asA('patch', `/api/v1/sale-returns/${created.body.id as string}/validate`).send();
  expect(validated.status).toBe(200);

  return { id: created.body.id as string, grandTotal: created.body.grandTotal as string };
}

/** Crée un achat COMPLETED (hors HTTP) puis un PurchaseReturn COMPLETED (via HTTP). */
async function createValidatedPurchaseReturn(price: string, quantity: string): Promise<{ id: string; grandTotal: string }> {
  const total = new Decimal(price).times(quantity);
  const purchase = await prisma.purchase.create({
    data: {
      organizationId: orgAId,
      reference: `TST-PURC-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: new Date('2026-07-26'),
      userId: adminAId,
      providerId: providerAId,
      warehouseId: warehouseAId,
      grandTotal: total,
      status: 'COMPLETED',
    },
  });
  const detail = await prisma.purchaseDetail.create({
    data: {
      purchaseId: purchase.id,
      productId: productAId,
      price: new Decimal(price),
      taxAmount: new Decimal('0'),
      taxMethod: 'percentage',
      discount: new Decimal('0'),
      discountMethod: 'percentage',
      quantity: new Decimal(quantity),
      total,
    },
  });

  const created = await asA('post', '/api/v1/purchase-returns').send({
    purchaseId: purchase.id,
    date: '2026-07-27T00:00:00.000Z',
    details: [{ purchaseDetailId: detail.id, quantity }],
  });
  expect(created.status).toBe(201);
  const validated = await asA('patch', `/api/v1/purchase-returns/${created.body.id as string}/validate`).send();
  expect(validated.status).toBe(200);

  return { id: created.body.id as string, grandTotal: created.body.grandTotal as string };
}

// ─── POST /sale-returns/:id/payments ─────────────────────────────────────────

describe('POST /api/v1/sale-returns/:saleReturnId/payments', () => {
  it('201 — enregistre un remboursement et met à jour SaleReturn.paidAmount/paymentStatus en base', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10'); // grandTotal = 10000

    const res = await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^REM-\d{4}-\d+$/);
    expect(res.body.amount).toBe('4000');

    const inDb = await prisma.saleReturn.findUnique({ where: { id: saleReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('4000');
    expect(inDb!.paymentStatus).toBe('PARTIAL');
  });

  it('paiement partiel puis complémentaire → PARTIAL puis PAID', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10');

    const first = await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });
    expect(first.status).toBe(201);

    let inDb = await prisma.saleReturn.findUnique({ where: { id: saleReturn.id } });
    expect(inDb!.paymentStatus).toBe('PARTIAL');

    const second = await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-28T00:00:00.000Z',
      amount: '6000',
      method: 'MOBILE_MONEY',
    });
    expect(second.status).toBe(201);

    inDb = await prisma.saleReturn.findUnique({ where: { id: saleReturn.id } });
    expect(inDb!.paymentStatus).toBe('PAID');
    expect(inDb!.paidAmount.toString()).toBe('10000');
  });

  it('400 — montant dépassant le solde restant, SaleReturn inchangé en base', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10');

    const res = await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '10001',
      method: 'CASH',
    });

    expect(res.status).toBe(400);
    const inDb = await prisma.saleReturn.findUnique({ where: { id: saleReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('0');
    expect(inDb!.paymentStatus).toBe('UNPAID');
  });

  it('isolation tenant — org B ne peut pas rembourser un retour de vente de org A', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10');

    const res = await asB('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '1000',
      method: 'CASH',
    });
    expect(res.status).toBe(403);

    const inDb = await prisma.saleReturn.findUnique({ where: { id: saleReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('0');
  });
});

// ─── POST /purchase-returns/:id/payments ─────────────────────────────────────

describe('POST /api/v1/purchase-returns/:purchaseReturnId/payments', () => {
  it('201 — enregistre un remboursement et met à jour PurchaseReturn.paidAmount/paymentStatus en base', async () => {
    const purchaseReturn = await createValidatedPurchaseReturn('1000', '10'); // grandTotal = 10000

    const res = await asA('post', `/api/v1/purchase-returns/${purchaseReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '5000',
      method: 'BANK_TRANSFER',
    });

    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^REM-\d{4}-\d+$/);

    const inDb = await prisma.purchaseReturn.findUnique({ where: { id: purchaseReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('5000');
    expect(inDb!.paymentStatus).toBe('PARTIAL');
  });

  it('400 — montant dépassant le solde restant, PurchaseReturn inchangé en base', async () => {
    const purchaseReturn = await createValidatedPurchaseReturn('1000', '10');

    const res = await asA('post', `/api/v1/purchase-returns/${purchaseReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '10001',
      method: 'CASH',
    });

    expect(res.status).toBe(400);
    const inDb = await prisma.purchaseReturn.findUnique({ where: { id: purchaseReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('0');
  });

  it('isolation tenant — org B ne peut pas rembourser un retour fournisseur de org A', async () => {
    const purchaseReturn = await createValidatedPurchaseReturn('1000', '10');

    const res = await asB('post', `/api/v1/purchase-returns/${purchaseReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '1000',
      method: 'CASH',
    });
    expect(res.status).toBe(403);
  });
});

// ─── GET historique ───────────────────────────────────────────────────────────

describe('GET /api/v1/sale-returns/:saleReturnId/payments', () => {
  it('200 — historique trié chronologiquement (date ASC)', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10');

    await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-28T00:00:00.000Z',
      amount: '2000',
      method: 'CASH',
    });
    await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '1000',
      method: 'CARD',
    });

    const res = await asA('get', `/api/v1/sale-returns/${saleReturn.id}/payments`);
    expect(res.status).toBe(200);
    const dates = (res.body as { date: string }[]).map((p) => p.date);
    const sorted = [...dates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    expect(dates).toEqual(sorted);
  });
});

// ─── PATCH payments/:id ──────────────────────────────────────────────────────

describe('PATCH /api/v1/sale-returns/payments/:id et /api/v1/purchase-returns/payments/:id', () => {
  it('200 — modifie le montant et recalcule SaleReturn.paidAmount/paymentStatus', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10');
    const created = await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    const res = await asA('patch', `/api/v1/sale-returns/payments/${created.body.id as string}`).send({ amount: '10000' });

    expect(res.status).toBe(200);
    const inDb = await prisma.saleReturn.findUnique({ where: { id: saleReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('10000');
    expect(inDb!.paymentStatus).toBe('PAID');
  });

  it('200 — modifie le montant et recalcule PurchaseReturn.paidAmount/paymentStatus', async () => {
    const purchaseReturn = await createValidatedPurchaseReturn('1000', '10');
    const created = await asA('post', `/api/v1/purchase-returns/${purchaseReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    const res = await asA('patch', `/api/v1/purchase-returns/payments/${created.body.id as string}`).send({ amount: '10000' });

    expect(res.status).toBe(200);
    const inDb = await prisma.purchaseReturn.findUnique({ where: { id: purchaseReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('10000');
    expect(inDb!.paymentStatus).toBe('PAID');
  });

  it('400 — le nouveau montant dépasse le solde restant', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10');
    const created = await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    const res = await asA('patch', `/api/v1/sale-returns/payments/${created.body.id as string}`).send({ amount: '10001' });
    expect(res.status).toBe(400);
  });
});

// ─── DELETE payments/:id — redescente PAID → PARTIAL → UNPAID ───────────────

describe('DELETE /api/v1/sale-returns/payments/:id et /api/v1/purchase-returns/payments/:id', () => {
  it('204 — supprime le paiement, SaleReturn redescend PAID → PARTIAL', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10'); // grandTotal = 10000
    const first = await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });
    await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-28T00:00:00.000Z',
      amount: '6000',
      method: 'CASH',
    });

    let inDb = await prisma.saleReturn.findUnique({ where: { id: saleReturn.id } });
    expect(inDb!.paymentStatus).toBe('PAID');

    const res = await asA('delete', `/api/v1/sale-returns/payments/${first.body.id as string}`);
    expect(res.status).toBe(204);

    inDb = await prisma.saleReturn.findUnique({ where: { id: saleReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('6000');
    expect(inDb!.paymentStatus).toBe('PARTIAL');
  });

  it('204 — supprime le dernier paiement, PurchaseReturn redescend PARTIAL → UNPAID', async () => {
    const purchaseReturn = await createValidatedPurchaseReturn('1000', '10');
    const created = await asA('post', `/api/v1/purchase-returns/${purchaseReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '3000',
      method: 'CASH',
    });

    let inDb = await prisma.purchaseReturn.findUnique({ where: { id: purchaseReturn.id } });
    expect(inDb!.paymentStatus).toBe('PARTIAL');

    const res = await asA('delete', `/api/v1/purchase-returns/payments/${created.body.id as string}`);
    expect(res.status).toBe(204);

    inDb = await prisma.purchaseReturn.findUnique({ where: { id: purchaseReturn.id } });
    expect(inDb!.paidAmount.toString()).toBe('0');
    expect(inDb!.paymentStatus).toBe('UNPAID');
  });

  it("isolation tenant — org B ne peut pas supprimer un paiement d'org A", async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '10');
    const created = await asA('post', `/api/v1/sale-returns/${saleReturn.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    const res = await asB('delete', `/api/v1/sale-returns/payments/${created.body.id as string}`);
    expect(res.status).toBe(403);

    const stillThere = await prisma.paymentReturn.findUnique({ where: { id: created.body.id as string } });
    expect(stillThere).not.toBeNull();
  });
});

// ─── Contrainte CHECK SQL en base — défense en profondeur ────────────────────
//
// L'invariant « exactement un des deux parents (saleReturnId, purchaseReturnId) est non-null »
// est vérifié en application (PaymentReturnService) ET par une contrainte CHECK SQL
// (payment_returns_exactly_one_parent_chk, num_nonnulls = 1). Ce bloc prouve que la défense en
// profondeur fonctionne RÉELLEMENT en base, indépendamment de l'application : une insertion SQL
// brute qui contournerait complètement le service doit être rejetée par Postgres lui-même.

describe('Contrainte CHECK SQL payment_returns_exactly_one_parent_chk', () => {
  it('rejette une insertion avec les DEUX FK (saleReturnId ET purchaseReturnId) non-null', async () => {
    const saleReturn = await createValidatedSaleReturn('1000', '2');
    const purchaseReturn = await createValidatedPurchaseReturn('1000', '2');
    const id = randomUUID();

    let caught: unknown;
    try {
      await prisma.$executeRaw`
        INSERT INTO "payment_returns"
          ("id", "organizationId", "saleReturnId", "purchaseReturnId", "userId", "date", "reference", "amount", "method", "change", "notes", "createdAt", "updatedAt")
        VALUES
          (${id}::uuid, ${orgAId}::uuid, ${saleReturn.id}::uuid, ${purchaseReturn.id}::uuid, ${adminAId}::uuid, now(), ${'CHK-TEST-BOTH'}, 100, 'CASH'::"PaymentMethod", 0, NULL, now(), now())
      `;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const message = caught instanceof Error ? `${caught.message} ${JSON.stringify((caught as { meta?: unknown }).meta ?? {})}` : String(caught);
    expect(message).toContain('payment_returns_exactly_one_parent_chk');

    const inserted = await prisma.paymentReturn.findUnique({ where: { id } });
    expect(inserted).toBeNull();
  });

  it('rejette une insertion avec les DEUX FK (saleReturnId ET purchaseReturnId) null', async () => {
    const id = randomUUID();

    let caught: unknown;
    try {
      await prisma.$executeRaw`
        INSERT INTO "payment_returns"
          ("id", "organizationId", "saleReturnId", "purchaseReturnId", "userId", "date", "reference", "amount", "method", "change", "notes", "createdAt", "updatedAt")
        VALUES
          (${id}::uuid, ${orgAId}::uuid, NULL, NULL, ${adminAId}::uuid, now(), ${'CHK-TEST-NEITHER'}, 100, 'CASH'::"PaymentMethod", 0, NULL, now(), now())
      `;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const message = caught instanceof Error ? `${caught.message} ${JSON.stringify((caught as { meta?: unknown }).meta ?? {})}` : String(caught);
    expect(message).toContain('payment_returns_exactly_one_parent_chk');

    const inserted = await prisma.paymentReturn.findUnique({ where: { id } });
    expect(inserted).toBeNull();
  });
});
