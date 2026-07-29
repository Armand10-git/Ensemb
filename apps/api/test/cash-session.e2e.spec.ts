/**
 * Tests d'intégration CashSessionModule (S23b — Bloc E, §18.2).
 *
 * Couvre le critère « Fait quand » du plan : une journée de caisse s'ouvre, encaisse, se
 * clôture avec un écart calculé et journalisé.
 *
 *  - POST /cash-sessions/open : 201, référence CS-…, 409 si une session OPEN existe déjà
 *  - GET /cash-sessions/current : session OPEN de l'appelant ou null (jamais 204)
 *  - Parcours complet : ouverture → vente CASH + vente CARD (POS) → clôture → expectedClosingAmount
 *    = openingAmount + CASH uniquement (CARD exclu), variance calculée correctement
 *  - PATCH /cash-sessions/:id/close : IDOR (organizationId + userId propriétaire), 400 si déjà CLOSED
 *  - Isolation tenant sur toutes les routes
 *  - PosService.createSale() : 400 après clôture de la session (gate S23b, non-régression)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
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
import { SalesModule } from '../src/modules/sales/sale.module';
import { BillingModule } from '../src/modules/billing/billing.module';
import { PosModule } from '../src/modules/pos/pos.module';
import { CashSessionModule } from '../src/modules/cash-sessions/cash-session.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-cs-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-cs-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;   // caissier 1, org A
let tokenA2: string;  // caissier 2, org A (session distincte, IDOR sur close)
let tokenB: string;   // org B (isolation tenant)
let clientAId: string;
let warehouseAId: string;
let productAId: string;

const PERMS = ['sales.create', 'sales.view', 'cashsessions.view', 'cashsessions.open', 'cashsessions.close'];

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E CashSession Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E CashSession Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  for (const name of PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const perms = await prisma.permission.findMany({ where: { name: { in: PERMS } }, select: { id: true } });

  async function setupUser(orgId: string, email: string, roleName: string) {
    const role = await prisma.role.create({ data: { organizationId: orgId, name: roleName } });
    for (const p of perms) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Test',
        lastname: 'Caisse',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  await setupUser(orgAId, `cs-a-${SUFFIX}@e2e.cm`, 'Caissier 1');
  await setupUser(orgAId, `cs-a2-${SUFFIX}@e2e.cm`, 'Caissier 2');
  await setupUser(orgBId, `cs-b-${SUFFIX}@e2e.cm`, 'Caissier B');

  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-CS-${SUFFIX}`, name: 'Cat CashSession A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-CS-${SUFFIX}`,
      name: 'Produit CashSession A',
      cost: '500',
      price: '1000',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH CS-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  const clientA = await prisma.client.create({
    data: { organizationId: orgAId, name: `Client CS ${SUFFIX}`, code: 1 },
  });
  clientAId = clientA.id;

  await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('100'), version: 0 },
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
      SalesModule,
      BillingModule,
      PosModule,
      CashSessionModule,
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

  tokenA = await login(orgAId, `cs-a-${SUFFIX}@e2e.cm`);
  tokenA2 = await login(orgAId, `cs-a2-${SUFFIX}@e2e.cm`);
  tokenB = await login(orgBId, `cs-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  await prisma.paymentSale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.saleDetail.deleteMany({ where: { sale: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.sale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.cashSession.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.client.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
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

function callA(method: 'get' | 'post' | 'patch', path: string) {
  return supertest(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokenA}`).set('X-Organization-Id', orgAId);
}
function callA2(method: 'get' | 'post' | 'patch', path: string) {
  return supertest(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokenA2}`).set('X-Organization-Id', orgAId);
}
function callB(method: 'get' | 'post' | 'patch', path: string) {
  return supertest(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokenB}`).set('X-Organization-Id', orgBId);
}

async function closeAnyOpenSession(userId: string) {
  const open = await prisma.cashSession.findFirst({ where: { organizationId: orgAId, userId, status: 'OPEN' } });
  if (open) await prisma.cashSession.update({ where: { id: open.id }, data: { status: 'CLOSED', closedAt: new Date() } });
}

// ─── POST /cash-sessions/open · GET /cash-sessions/current ─────────────────────

describe('POST /api/v1/cash-sessions/open', () => {
  afterEach(async () => {
    const userA = await prisma.user.findFirst({ where: { organizationId: orgAId, email: `cs-a-${SUFFIX}@e2e.cm` } });
    if (userA) await closeAnyOpenSession(userA.id);
  });

  it('201 — ouvre une session avec référence CS-…, statut OPEN', async () => {
    const res = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '5000' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.reference).toMatch(/^CS-\d{4}-\d{6}$/);
    expect(res.body.openingAmount).toBe('5000');
  });

  it('409 — une seconde session pour le même caissier est refusée', async () => {
    await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '5000' });

    const res = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '1000' });

    expect(res.status).toBe(409);
  });

  it("403 — isolation tenant : org B ne peut pas ouvrir de session sur un entrepôt d'org A", async () => {
    const res = await callB('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '5000' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/cash-sessions/current', () => {
  afterEach(async () => {
    const userA = await prisma.user.findFirst({ where: { organizationId: orgAId, email: `cs-a-${SUFFIX}@e2e.cm` } });
    if (userA) await closeAnyOpenSession(userA.id);
  });

  it('200 — retourne null (jamais 204) si aucune session OPEN', async () => {
    const res = await callA('get', `/api/v1/cash-sessions/current?warehouseId=${warehouseAId}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('200 — retourne la session OPEN de l’appelant une fois ouverte', async () => {
    const opened = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '5000' });

    const res = await callA('get', `/api/v1/cash-sessions/current?warehouseId=${warehouseAId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(opened.body.id);
  });
});

// ─── Parcours complet : ouverture → ventes → clôture → écart ───────────────────

describe('Parcours complet — ouverture, encaissement, clôture avec écart (§14, S23b)', () => {
  afterEach(async () => {
    const userA = await prisma.user.findFirst({ where: { organizationId: orgAId, email: `cs-a-${SUFFIX}@e2e.cm` } });
    if (userA) await closeAnyOpenSession(userA.id);
  });

  it('expectedClosingAmount = openingAmount + CASH uniquement (CARD exclu), variance = compté - attendu', async () => {
    const opened = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '10000' });
    const sessionId = opened.body.id as string;

    // Vente CASH — contribue au tiroir physique.
    const cashSale = await callA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '3' }],
      paymentMethod: 'CASH',
      amountReceived: '3000',
    });
    expect(cashSale.status).toBe(201);

    // Vente CARD — ne touche jamais le tiroir physique, doit être exclue du calcul.
    const cardSale = await callA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '5' }],
      paymentMethod: 'CARD',
    });
    expect(cardSale.status).toBe(201);

    // Attendu en caisse = 10000 (fond) + 3000 (CASH) = 13000, CARD (5000) exclu.
    // Comptage physique volontairement différent pour vérifier le signe de l'écart.
    const closed = await callA('patch', `/api/v1/cash-sessions/${sessionId}/close`).send({ countedClosingAmount: '12800' });

    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.expectedClosingAmount).toBe('13000');
    expect(closed.body.countedClosingAmount).toBe('12800');
    // 12800 - 13000 = -200 (manque)
    expect(closed.body.variance).toBe('-200');

    // Le gate POS redevient bloquant : la session est CLOSED, une nouvelle vente est refusée.
    const afterClose = await callA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
      paymentMethod: 'CASH',
      amountReceived: '1000',
    });
    expect(afterClose.status).toBe(400);
  });

  it('détail GET /cash-sessions/:id expose les ventes rattachées', async () => {
    const opened = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '0' });
    const sessionId = opened.body.id as string;

    await callA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
      paymentMethod: 'CASH',
      amountReceived: '1000',
    });

    const detail = await callA('get', `/api/v1/cash-sessions/${sessionId}`);
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.body.sales)).toBe(true);
    expect(detail.body.sales.length).toBeGreaterThanOrEqual(1);

    await callA('patch', `/api/v1/cash-sessions/${sessionId}/close`).send({ countedClosingAmount: '1000' });
  });

  it("403 — sans records.viewAll, un caissier ne peut pas consulter le détail de la session d'un collègue (IDOR)", async () => {
    const opened = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '1000' });

    const res = await callA2('get', `/api/v1/cash-sessions/${opened.body.id}`);

    expect(res.status).toBe(403);

    await callA('patch', `/api/v1/cash-sessions/${opened.body.id}/close`).send({ countedClosingAmount: '1000' });
  });
});

// ─── PATCH /cash-sessions/:id/close — IDOR et statut ────────────────────────────

describe('PATCH /api/v1/cash-sessions/:id/close', () => {
  afterEach(async () => {
    const userA = await prisma.user.findFirst({ where: { organizationId: orgAId, email: `cs-a-${SUFFIX}@e2e.cm` } });
    if (userA) await closeAnyOpenSession(userA.id);
    const userA2 = await prisma.user.findFirst({ where: { organizationId: orgAId, email: `cs-a2-${SUFFIX}@e2e.cm` } });
    if (userA2) await closeAnyOpenSession(userA2.id);
  });

  it("403 — un caissier ne peut pas clôturer la session d'un autre caissier (IDOR)", async () => {
    const opened = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '1000' });

    const res = await callA2('patch', `/api/v1/cash-sessions/${opened.body.id}/close`).send({ countedClosingAmount: '1000' });

    expect(res.status).toBe(403);
    const stillOpen = await prisma.cashSession.findUnique({ where: { id: opened.body.id as string } });
    expect(stillOpen?.status).toBe('OPEN');
  });

  it("403 — isolation tenant : org B ne peut pas clôturer une session d'org A", async () => {
    const opened = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '1000' });

    const res = await callB('patch', `/api/v1/cash-sessions/${opened.body.id}/close`).send({ countedClosingAmount: '1000' });

    expect(res.status).toBe(403);
  });

  it('400 — une session déjà CLOSED ne peut pas être re-clôturée', async () => {
    const opened = await callA('post', '/api/v1/cash-sessions/open').send({ warehouseId: warehouseAId, openingAmount: '1000' });
    await callA('patch', `/api/v1/cash-sessions/${opened.body.id}/close`).send({ countedClosingAmount: '1000' });

    const res = await callA('patch', `/api/v1/cash-sessions/${opened.body.id}/close`).send({ countedClosingAmount: '1000' });

    expect(res.status).toBe(400);
  });
});
