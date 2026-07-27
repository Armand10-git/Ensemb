/**
 * Tests d'intégration PaymentSale (S20 — Bloc E, §18.5).
 *
 * Patron exact de sale.e2e.spec.ts (S19) : TenancyModule + header X-Organization-Id
 * (cf. dette documentée §14 de docs/roadmap/02-plan-et-decisions.md).
 *
 * Couvre :
 *  - POST /sales/:saleId/payments → 201, Sale.paidAmount/paymentStatus corrects en base
 *  - Paiement partiel puis complémentaire → PARTIAL puis PAID
 *  - Montant dépassant le solde → 400, Sale inchangée en base
 *  - Isolation tenant sur POST/PATCH/DELETE (saleId ou paymentId d'une autre organisation)
 *  - GET historique → liste triée chronologiquement
 *  - DELETE paiement → 204, recalcul vérifié en base
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
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
import { SalesModule } from '../src/modules/sales/sale.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-pay-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-pay-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let clientAId: string;
let warehouseAId: string;
let productAId: string;

const PERMS = [
  'sales.view',
  'sales.create',
  'sales.edit',
  'sales.delete',
  'records.viewAll',
  'paymentSales.view',
  'paymentSales.create',
  'paymentSales.edit',
  'paymentSales.delete',
];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E Payment Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Payment Org B', subdomain: ORG_B_SUBDOMAIN } });
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
        lastname: 'Payment',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  await setupUser(orgAId, `pay-a-${SUFFIX}@e2e.cm`, 'Admin');
  await setupUser(orgBId, `pay-b-${SUFFIX}@e2e.cm`, 'Admin');

  // Données de base pour org A
  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-PAY-A-${SUFFIX}`, name: 'Cat Payment A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-PAY-A-${SUFFIX}`,
      name: 'Produit Paiement A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;
  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH Payment-A-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;
  const clientA = await prisma.client.create({
    data: { organizationId: orgAId, name: `Client Payment A ${SUFFIX}`, code: 1 },
  });
  clientAId = clientA.id;

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
      TenancyModule,
      RealtimeModule,
      SalesModule,
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

  tokenA = await login(orgAId, `pay-a-${SUFFIX}@e2e.cm`);
  tokenB = await login(orgBId, `pay-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  await prisma.paymentSale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.saleDetail.deleteMany({ where: { sale: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.sale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.client.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.product.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
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

/** Crée une vente PENDING pour org A avec un grandTotal fixé via price × quantity. */
async function createSaleA(price: string, quantity: string): Promise<{ id: string; grandTotal: string }> {
  const res = await asA('post', '/api/v1/sales').send({
    clientId: clientAId,
    warehouseId: warehouseAId,
    date: '2026-07-26T00:00:00.000Z',
    details: [{ productId: productAId, price, quantity }],
  });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, grandTotal: res.body.grandTotal as string };
}

// ─── POST /sales/:saleId/payments ──────────────────────────────────────────────

describe('POST /api/v1/sales/:saleId/payments', () => {
  it('201 — encaisse un paiement et met à jour Sale.paidAmount/paymentStatus en base', async () => {
    const sale = await createSaleA('1000', '10'); // grandTotal = 10000

    const res = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^PAY-\d{4}-\d+$/);
    expect(res.body.amount).toBe('4000');

    const inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paidAmount.toString()).toBe('4000');
    expect(inDb!.paymentStatus).toBe('PARTIAL');
  });

  it('paiement partiel puis complémentaire → PARTIAL puis PAID', async () => {
    const sale = await createSaleA('1000', '10'); // grandTotal = 10000

    const first = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });
    expect(first.status).toBe(201);

    let inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paymentStatus).toBe('PARTIAL');
    expect(inDb!.paidAmount.toString()).toBe('4000');

    const second = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '6000',
      method: 'MOBILE_MONEY',
    });
    expect(second.status).toBe(201);

    inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paymentStatus).toBe('PAID');
    expect(inDb!.paidAmount.toString()).toBe('10000');
  });

  it('400 — montant dépassant le solde restant, Sale inchangée en base', async () => {
    const sale = await createSaleA('1000', '10'); // grandTotal = 10000

    const res = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '10001',
      method: 'CASH',
    });

    expect(res.status).toBe(400);

    const inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paidAmount.toString()).toBe('0');
    expect(inDb!.paymentStatus).toBe('UNPAID');
  });

  it('isolation tenant — org B ne peut pas payer une vente de org A', async () => {
    const sale = await createSaleA('1000', '10');

    const res = await asB('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '1000',
      method: 'CASH',
    });

    expect(res.status).toBe(403);

    const inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paidAmount.toString()).toBe('0');
  });

  it('401 — sans token', async () => {
    const sale = await createSaleA('1000', '10');
    const res = await supertest(app.getHttpServer())
      .post(`/api/v1/sales/${sale.id}/payments`)
      .set('X-Organization-Id', orgAId)
      .send({ date: '2026-07-26T00:00:00.000Z', amount: '1000', method: 'CASH' });
    expect(res.status).toBe(401);
  });
});

// ─── GET /sales/:saleId/payments ───────────────────────────────────────────────

describe('GET /api/v1/sales/:saleId/payments', () => {
  it('200 — historique trié chronologiquement (date ASC)', async () => {
    const sale = await createSaleA('1000', '10');

    await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '2000',
      method: 'CASH',
    });
    await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-25T00:00:00.000Z',
      amount: '1000',
      method: 'CARD',
    });
    await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '1000',
      method: 'BANK_TRANSFER',
    });

    const res = await asA('get', `/api/v1/sales/${sale.id}/payments`);

    expect(res.status).toBe(200);
    const dates = (res.body as { date: string }[]).map((p) => p.date);
    const sorted = [...dates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    expect(dates).toEqual(sorted);
    expect(dates).toHaveLength(3);
  });

  it('isolation tenant — org B ne peut pas lire les paiements de la vente de org A', async () => {
    const sale = await createSaleA('1000', '10');
    await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '1000',
      method: 'CASH',
    });

    const res = await asB('get', `/api/v1/sales/${sale.id}/payments`);
    expect(res.status).toBe(403);
  });
});

// ─── PATCH /sales/payments/:id ──────────────────────────────────────────────────

describe('PATCH /api/v1/sales/payments/:id', () => {
  it('200 — modifie le montant et recalcule Sale.paidAmount/paymentStatus', async () => {
    const sale = await createSaleA('1000', '10'); // grandTotal = 10000
    const created = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    const res = await asA('patch', `/api/v1/sales/payments/${created.body.id}`).send({ amount: '10000' });

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe('10000');

    const inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paidAmount.toString()).toBe('10000');
    expect(inDb!.paymentStatus).toBe('PAID');
  });

  it('400 — le nouveau montant dépasse le solde restant', async () => {
    const sale = await createSaleA('1000', '10'); // grandTotal = 10000
    const created = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    const res = await asA('patch', `/api/v1/sales/payments/${created.body.id}`).send({ amount: '10001' });

    expect(res.status).toBe(400);
    const inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paidAmount.toString()).toBe('4000');
  });

  it("isolation tenant — org B ne peut pas modifier un paiement d'org A", async () => {
    const sale = await createSaleA('1000', '10');
    const created = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    const res = await asB('patch', `/api/v1/sales/payments/${created.body.id}`).send({ amount: '5000' });
    expect(res.status).toBe(403);

    const inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paidAmount.toString()).toBe('4000');
  });
});

// ─── DELETE /sales/payments/:id ─────────────────────────────────────────────────

describe('DELETE /api/v1/sales/payments/:id', () => {
  it('204 — supprime le paiement et recalcule Sale.paidAmount/paymentStatus en base', async () => {
    const sale = await createSaleA('1000', '10'); // grandTotal = 10000
    const first = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });
    await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-27T00:00:00.000Z',
      amount: '6000',
      method: 'CASH',
    });

    let inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paymentStatus).toBe('PAID');

    const res = await asA('delete', `/api/v1/sales/payments/${first.body.id}`);
    expect(res.status).toBe(204);

    inDb = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(inDb!.paidAmount.toString()).toBe('6000');
    expect(inDb!.paymentStatus).toBe('PARTIAL');

    const remaining = await prisma.paymentSale.findMany({ where: { saleId: sale.id } });
    expect(remaining).toHaveLength(1);
  });

  it("isolation tenant — org B ne peut pas supprimer un paiement d'org A", async () => {
    const sale = await createSaleA('1000', '10');
    const created = await asA('post', `/api/v1/sales/${sale.id}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '4000',
      method: 'CASH',
    });

    const res = await asB('delete', `/api/v1/sales/payments/${created.body.id}`);
    expect(res.status).toBe(403);

    const stillThere = await prisma.paymentSale.findUnique({ where: { id: created.body.id as string } });
    expect(stillThere).not.toBeNull();
  });
});
