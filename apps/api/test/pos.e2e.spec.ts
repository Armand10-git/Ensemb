/**
 * Tests d'intégration PosModule (S22 — Bloc E, §18.2).
 *
 * Couvre :
 *  - GET /pos/products/search : recherche nom/code + quantité live par entrepôt
 *  - POST /pos/calculate-total : recalcul serveur pur, ne persiste rien
 *  - POST /pos/sales : création atomique (stock + paiement), CASH/CARD/MOBILE_MONEY,
 *    stock insuffisant (400 avec message clair), isolation tenant, et le test de
 *    concurrence critère « Fait quand » du plan (dernier exemplaire, deux caisses
 *    simultanées, une seule réussit).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, INestApplication } from '@nestjs/common';
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
import { SaleService } from '../src/modules/sales/sale.service';
import { BillingModule } from '../src/modules/billing/billing.module';
import { PosModule } from '../src/modules/pos/pos.module';
import { PosService } from '../src/modules/pos/pos.service';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-pos-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-pos-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let clientAId: string;
let warehouseAId: string;
let productAId: string;
let pwId: string;
let userAId: string;
let cashSessionAId: string;
let warehouseNoSessionId: string;
let posService: PosService;
let saleService: SaleService;

const PERMS = ['sales.create', 'sales.view'];

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E POS Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E POS Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  for (const name of PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const perms = await prisma.permission.findMany({ where: { name: { in: PERMS } }, select: { id: true } });

  async function setupUser(orgId: string, email: string) {
    const role = await prisma.role.create({ data: { organizationId: orgId, name: 'Caissier' } });
    for (const p of perms) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Test',
        lastname: 'Pos',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  userAId = await setupUser(orgAId, `pos-a-${SUFFIX}@e2e.cm`);
  await setupUser(orgBId, `pos-b-${SUFFIX}@e2e.cm`);

  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-POS-${SUFFIX}`, name: 'Cat POS A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-POS-${SUFFIX}`,
      name: 'Produit POS A',
      cost: '500',
      price: '1000',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH POS-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  // Entrepôt sans session de caisse OPEN — pour le test du gate S23b ci-dessous.
  const whNoSession = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH POS No-Session-${SUFFIX}` },
  });
  warehouseNoSessionId = whNoSession.id;

  const clientA = await prisma.client.create({
    data: { organizationId: orgAId, name: `Client POS ${SUFFIX}`, code: 1 },
  });
  clientAId = clientA.id;

  const pw = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('100'), version: 0 },
  });
  pwId = pw.id;

  // S23b — PosService.createSale() exige désormais une session de caisse OPEN pour
  // (organizationId, userId, warehouseId) : créée directement en base (pas via l'API
  // /cash-sessions, hors permission/périmètre de cette suite POS) pour que tous les tests
  // POST /pos/sales existants restent valides. Testée pour elle-même dans cash-session.e2e.spec.ts.
  const csA = await prisma.cashSession.create({
    data: {
      organizationId: orgAId,
      reference: `CS-E2E-${SUFFIX}-A`,
      warehouseId: warehouseAId,
      userId: userAId,
      openingAmount: new Decimal('0'),
      status: 'OPEN',
    },
  });
  cashSessionAId = csA.id;

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
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  posService = moduleRef.get(PosService);
  saleService = moduleRef.get(SaleService);

  async function login(orgId: string, email: string): Promise<string> {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ email, password: 'TestPass!1' });
    return res.body.accessToken as string;
  }

  tokenA = await login(orgAId, `pos-a-${SUFFIX}@e2e.cm`);
  tokenB = await login(orgBId, `pos-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  // paymentWithCreditCard AVANT paymentSale (FK payment_with_credit_card_paymentSaleId_fkey) —
  // nécessaire depuis l'ajout des tests de compétition webhook/expiration CARD (S31) qui créent
  // désormais des PaymentWithCreditCard dans ce fichier.
  await prisma.paymentWithCreditCard.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
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

function asA(method: 'get' | 'post', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenA}`)
    .set('X-Organization-Id', orgAId);
}
function asB(method: 'get' | 'post', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenB}`)
    .set('X-Organization-Id', orgBId);
}

async function resetStock(quantity: string) {
  await prisma.productWarehouse.update({
    where: { id: pwId },
    data: { quantity: new Decimal(quantity), version: 0 },
  });
}

// ─── GET /pos/products/search ──────────────────────────────────────────────────

describe('GET /api/v1/pos/products/search', () => {
  it('200 — retourne le produit avec sa quantité live dans l\'entrepôt', async () => {
    await resetStock('37');

    const res = await asA('get', `/api/v1/pos/products/search?warehouseId=${warehouseAId}&q=POS`);

    expect(res.status).toBe(200);
    const found = (res.body as { id: string; quantity: string }[]).find((p) => p.id === productAId);
    expect(found).toBeDefined();
    expect(found!.quantity).toBe('37');
  });

  it('400 — warehouseId absent', async () => {
    const res = await asA('get', '/api/v1/pos/products/search?q=POS');
    expect(res.status).toBe(400);
  });

  it('403 — org B ne peut pas chercher dans un entrepôt de org A', async () => {
    const res = await asB('get', `/api/v1/pos/products/search?warehouseId=${warehouseAId}&q=POS`);
    expect(res.status).toBe(403);
  });
});

// ─── POST /pos/calculate-total ──────────────────────────────────────────────────

describe('POST /api/v1/pos/calculate-total', () => {
  it('200 — recalcule le total côté serveur, ne persiste rien', async () => {
    const res = await asA('post', '/api/v1/pos/calculate-total').send({
      taxRate: '10',
      discount: '100',
      shipping: '50',
      details: [{ productId: productAId, price: '1000', quantity: '2' }],
    });

    expect(res.status).toBe(200);
    // sumLines = 2000, taxGlobal = 200, discount = 100, shipping = 50 → 2150
    expect(res.body.grandTotal).toBe('2150');

    const salesCount = await prisma.sale.count({ where: { organizationId: orgAId } });
    expect(salesCount).toBe(0);
  });
});

// ─── POST /pos/sales ─────────────────────────────────────────────────────────

describe('POST /api/v1/pos/sales', () => {
  it('201 — CASH : crée la vente COMPLETED, décrémente le stock, crée le PaymentSale avec la monnaie rendue', async () => {
    await resetStock('50');

    const res = await asA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '3' }],
      paymentMethod: 'CASH',
      amountReceived: '3500',
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.isPos).toBe(true);
    expect(res.body.grandTotal).toBe('3000');

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('47');

    const payments = await prisma.paymentSale.findMany({ where: { saleId: res.body.id as string } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.method).toBe('CASH');
    expect(new Decimal(payments[0]!.change ?? '0').toString()).toBe('500');
    expect(new Decimal(payments[0]!.amount).toString()).toBe('3000');

    // S23b — la vente est rattachée à la session de caisse OPEN de l'entrepôt/utilisateur.
    const sale = await prisma.sale.findUnique({ where: { id: res.body.id as string }, select: { cashSessionId: true } });
    expect(sale?.cashSessionId).toBe(cashSessionAId);
  });

  it("400 — S23b : aucune session de caisse OPEN pour cet entrepôt, aucune vente créée", async () => {
    const res = await asA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseNoSessionId,
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
      paymentMethod: 'CASH',
      amountReceived: '1000',
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/session de caisse/i);

    const salesCount = await prisma.sale.count({ where: { organizationId: orgAId, warehouseId: warehouseNoSessionId } });
    expect(salesCount).toBe(0);
  });

  it('400 — CASH : amountReceived insuffisant, aucun décrément ni PaymentSale', async () => {
    await resetStock('50');

    const res = await asA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
      paymentMethod: 'CASH',
      amountReceived: '500',
    });

    expect(res.status).toBe(400);
    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('50');
  });

  it('201 — CARD : status AWAITING_PAYMENT, stock déjà décrémenté, lien de paiement retourné, aucun PaymentSale (S31 — CARD suit désormais le même flux asynchrone que MOBILE_MONEY)', async () => {
    await resetStock('50');

    const res = await asA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '2' }],
      paymentMethod: 'CARD',
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('AWAITING_PAYMENT');
    expect(typeof res.body.paymentLink).toBe('string');
    expect(res.body.paymentLink).toMatch(/^https:\/\/pay\.test\/mock-/);

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('48');

    const payments = await prisma.paymentSale.findMany({ where: { saleId: res.body.id as string } });
    expect(payments).toHaveLength(0);
  });

  it('400 — stock insuffisant : message clair, aucun décrément, aucune vente créée', async () => {
    await resetStock('1');

    const res = await asA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '5' }],
      paymentMethod: 'CASH',
      amountReceived: '5000',
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/stock insuffisant/i);

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('1');
  });

  it('201 — MOBILE_MONEY : status AWAITING_PAYMENT, stock déjà décrémenté, lien de paiement retourné, aucun PaymentSale', async () => {
    await resetStock('50');

    const res = await asA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '4' }],
      paymentMethod: 'MOBILE_MONEY',
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('AWAITING_PAYMENT');
    expect(typeof res.body.paymentLink).toBe('string');
    expect(res.body.paymentLink).toMatch(/^https:\/\/pay\.test\/mock-/);

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('46');

    const payments = await prisma.paymentSale.findMany({ where: { saleId: res.body.id as string } });
    expect(payments).toHaveLength(0);
  });

  it('403 — isolation tenant : org B ne peut pas vendre avec un client/entrepôt de org A', async () => {
    await resetStock('50');

    const res = await asB('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
      paymentMethod: 'CASH',
      amountReceived: '1000',
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('50');
  });

  it(
    'concurrence — deux ventes POS simultanées sur le dernier exemplaire : exactement une 201 ' +
      'et une 400/409, stock final = 0 (jamais négatif, jamais 1)',
    async () => {
      await resetStock('1');

      const payload = {
        clientId: clientAId,
        warehouseId: warehouseAId,
        details: [{ productId: productAId, price: '1000', quantity: '1' }],
        paymentMethod: 'CASH',
        amountReceived: '1000',
      };

      const [res1, res2] = await Promise.all([
        asA('post', '/api/v1/pos/sales').send(payload),
        asA('post', '/api/v1/pos/sales').send(payload),
      ]);

      const statuses = [res1.status, res2.status].sort((a, b) => a - b);
      // Exactement une 201 ; l'autre échoue (400 stock insuffisant relu, ou 409 conflit de sérialisation).
      // Tri ascendant : 201 est toujours plus petit que 400/409, donc le succès est à l'index 0.
      expect(statuses[0]).toBe(201);
      expect([400, 409]).toContain(statuses[1]);

      const pw = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
      expect(new Decimal(pw!.quantity).toString()).toBe('0');
    },
  );
});

// ─── Compétition confirmation webhook vs expiration — CARD (S31) ───────────────
//
// Le webhook mobile money (S22) et le webhook carte (S31) partagent désormais exactement le
// même flux asynchrone (AWAITING_PAYMENT + PosPaymentExpirationWorker, cf. JSDoc de
// PosService) : la variante CARD de cette compétition webhook/expiration devait déjà être
// couverte, pas seulement MOBILE_MONEY. Les méthodes de service sont appelées directement
// (PosService.confirmAsyncPayment, SaleService.expireAwaitingPayment — exactement l'appel
// que fait PosPaymentExpirationWorker.process(), S31) plutôt que d'attendre un vrai délai
// BullMQ, comme le fait déjà pos-payment-expiration.worker.spec.ts.

describe('Compétition confirmation webhook vs expiration — CARD (absence de double restitution)', () => {
  const CARD_CONFIRMATION = {
    provider: 'CARD' as const,
    providerCustomerId: 'card-cust-race',
    providerTransactionId: 'card-txn-race',
  };

  /** Crée une vente POS CARD (AWAITING_PAYMENT) à partir d'un stock remis à 50. */
  async function createCardSale(quantity: string): Promise<string> {
    await resetStock('50');
    const res = await asA('post', '/api/v1/pos/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      details: [{ productId: productAId, price: '1000', quantity }],
      paymentMethod: 'CARD',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('AWAITING_PAYMENT');
    return res.body.id as string;
  }

  it(
    "confirmation webhook réussit avant l'expiration (retardée) → la vente payée n'est " +
      'JAMAIS repassée CANCELLED, son stock JAMAIS restitué une seconde fois',
    async () => {
      const saleId = await createCardSale('2');
      const pwAfterCreate = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
      expect(new Decimal(pwAfterCreate!.quantity).toString()).toBe('48');

      // 1. Le paiement carte est confirmé par l'agrégateur (webhook) — AWAITING_PAYMENT → COMPLETED.
      await posService.confirmAsyncPayment(orgAId, saleId, CARD_CONFIRMATION);
      const saleAfterConfirm = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(saleAfterConfirm!.status).toBe('COMPLETED');

      // 2. Le job d'expiration différé (enfilé à la création) se déclenche ensuite, en retard —
      //    exactement l'appel que fait PosPaymentExpirationWorker.process(). BadRequestException
      //    est absorbée en production par le worker (no-op) ; toute autre exception est un échec réel.
      try {
        await saleService.expireAwaitingPayment(
          saleId,
          orgAId,
          'Expiration du délai de paiement mobile money',
        );
      } catch (err) {
        if (!(err instanceof BadRequestException)) throw err;
      }

      // 3. Invariant métier : une vente déjà payée ne doit jamais être annulée ni restituée une
      //    deuxième fois par l'expiration tardive — le client a payé, le produit est vendu.
      const saleAfterExpiration = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(saleAfterExpiration!.status).toBe('COMPLETED');

      const pwAfterExpiration = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
      expect(new Decimal(pwAfterExpiration!.quantity).toString()).toBe('48');

      const payments = await prisma.paymentSale.findMany({ where: { saleId } });
      expect(payments).toHaveLength(1);
    },
    15_000,
  );

  it(
    "expiration s'exécute avant la confirmation → CANCELLED, stock restitué UNE SEULE FOIS ; " +
      'confirmation webhook tardive ensuite → no-op, jamais de PaymentSale sur une vente CANCELLED',
    async () => {
      const saleId = await createCardSale('3');
      const pwAfterCreate = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
      expect(new Decimal(pwAfterCreate!.quantity).toString()).toBe('47');

      // 1. Expiration en premier — exactement l'appel que fait PosPaymentExpirationWorker.process().
      await saleService.expireAwaitingPayment(
        saleId,
        orgAId,
        'Expiration du délai de paiement mobile money',
      );
      const saleAfterExpiration = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(saleAfterExpiration!.status).toBe('CANCELLED');

      const pwAfterExpiration = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
      expect(new Decimal(pwAfterExpiration!.quantity).toString()).toBe('50');

      // 2. Confirmation webhook tardive — la vente n'est plus AWAITING_PAYMENT : no-op idempotent.
      await posService.confirmAsyncPayment(orgAId, saleId, CARD_CONFIRMATION);

      const saleAfterLateConfirm = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(saleAfterLateConfirm!.status).toBe('CANCELLED');

      const pwAfterLateConfirm = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
      expect(new Decimal(pwAfterLateConfirm!.quantity).toString()).toBe('50');

      const payments = await prisma.paymentSale.findMany({ where: { saleId } });
      expect(payments).toHaveLength(0);
    },
  );
});
