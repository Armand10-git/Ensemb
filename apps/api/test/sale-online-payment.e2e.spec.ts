/**
 * Tests d'intégration — paiement en ligne différé sur une vente classique hors-POS (S31,
 * §17 point V).
 *
 * Décision de conception centrale testée ici (immutabilité, §17 règle 7) : contrairement au
 * flux POS (AWAITING_PAYMENT/expiration → SaleService.expireAwaitingPayment(), restitution de stock),
 * l'agrégateur sur une vente classique est totalement DÉCOUPLÉ de Sale.status et du stock —
 * le stock d'une vente classique n'est mouvementé qu'à validate() (S21), jamais par ce flux.
 * OnlinePaymentIntent porte seul l'attente, jamais Sale.
 *
 * Couvre :
 *  - POST /sales/:saleId/payments/online : retourne { intentId, paymentLink, expiresAt },
 *    aucun PaymentSale créé à ce stade.
 *  - Refus si amount dépasse le solde restant de la vente.
 *  - Webhook payment.success avec intentId → PaymentSale + PaymentWithCreditCard créés,
 *    OnlinePaymentIntent CONFIRMED, Sale.status INCHANGÉ.
 *  - Rejeu idempotent du même providerEventId → un seul PaymentSale.
 *  - Expiration (appel direct de SaleOnlinePaymentService.expirePayment, pattern déjà utilisé
 *    par pos-payment-expiration.worker.spec.ts pour éviter un vrai délai BullMQ) →
 *    OnlinePaymentIntent EXPIRED, aucune restitution de stock, Sale.status inchangé.
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
import { PosModule } from '../src/modules/pos/pos.module';
import { PaymentGatewayModule } from '../src/modules/payment-gateway/payment-gateway.module';
import { PaymentsWebhookModule } from '../src/modules/payment-gateway/payments-webhook.module';
import { SaleOnlinePaymentService } from '../src/modules/sales/sale-online-payment.service';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_SUBDOMAIN = `e2e-sale-onlinepay-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let saleOnlinePaymentService: SaleOnlinePaymentService;
let orgId: string;
let token: string;
let clientId: string;
let warehouseId: string;
let productId: string;
let pwId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'E2E Sale Online Payment', subdomain: ORG_SUBDOMAIN } });
  orgId = org.id;

  const permNames = ['sales.create', 'sales.view', 'paymentSales.create'];
  for (const name of permNames) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const perms = await prisma.permission.findMany({ where: { name: { in: permNames } }, select: { id: true } });

  const role = await prisma.role.create({ data: { organizationId: orgId, name: 'Vendeur' } });
  for (const p of perms) {
    await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
  }
  const user = await prisma.user.create({
    data: {
      organizationId: orgId,
      firstname: 'Test',
      lastname: 'SaleOnlinePayment',
      email: `sale-onlinepay-${SUFFIX}@e2e.cm`,
      username: `sale-onlinepay-${SUFFIX}@e2e.cm`,
      password: await bcrypt.hash('TestPass!1', 12),
      isActive: true,
    },
  });
  await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });

  const cat = await prisma.category.create({
    data: { organizationId: orgId, code: `CAT-SOP-${SUFFIX}`, name: 'Cat Sale Online Payment' },
  });
  const prod = await prisma.product.create({
    data: {
      organizationId: orgId,
      code: `PROD-SOP-${SUFFIX}`,
      name: 'Produit Sale Online Payment',
      cost: '500',
      price: '1000',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: cat.id,
    },
  });
  productId = prod.id;

  const wh = await prisma.warehouse.create({
    data: { organizationId: orgId, name: `WH Sale Online Payment-${SUFFIX}`, isDefault: true },
  });
  warehouseId = wh.id;

  const client = await prisma.client.create({
    data: { organizationId: orgId, name: `Client Sale Online Payment ${SUFFIX}`, code: 1 },
  });
  clientId = client.id;

  const pw = await prisma.productWarehouse.create({
    data: { productId, warehouseId, quantity: new Decimal('100'), version: 0 },
  });
  pwId = pw.id;

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
      PosModule,
      PaymentGatewayModule,
      PaymentsWebhookModule,
    ],
  }).compile();

  // rawBody: true est indispensable pour le webhook HMAC
  app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api/v1');
  await app.init();

  saleOnlinePaymentService = moduleRef.get(SaleOnlinePaymentService);

  const res = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgId)
    .send({ email: `sale-onlinepay-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();
  await prisma.webhookEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.paymentWithCreditCard.deleteMany({ where: { organizationId: orgId } });
  await prisma.paymentSale.deleteMany({ where: { organizationId: orgId } });
  await prisma.onlinePaymentIntent.deleteMany({ where: { organizationId: orgId } });
  await prisma.saleDetail.deleteMany({ where: { sale: { organizationId: orgId } } });
  await prisma.sale.deleteMany({ where: { organizationId: orgId } });
  await prisma.client.deleteMany({ where: { organizationId: orgId } });
  await prisma.productWarehouse.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { organizationId: orgId } });
  await prisma.category.deleteMany({ where: { organizationId: orgId } });
  await prisma.warehouse.deleteMany({ where: { organizationId: orgId } });
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: orgId } } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: orgId } } });
  await prisma.role.deleteMany({ where: { organizationId: orgId } });
  await prisma.documentCounter.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

/** Crée une vente classique PENDING (grandTotal calculé côté serveur à la création, S19). */
async function createSale(quantity = '1'): Promise<{ saleId: string; grandTotal: string; status: string }> {
  const res = await supertest(app.getHttpServer())
    .post('/api/v1/sales')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Organization-Id', orgId)
    .send({
      clientId,
      warehouseId,
      date: new Date().toISOString(),
      details: [{ productId, price: '1000', quantity }],
    });
  expect(res.status).toBe(201);
  return { saleId: res.body.id as string, grandTotal: res.body.grandTotal as string, status: res.body.status as string };
}

function postWebhook(payload: object) {
  return supertest(app.getHttpServer())
    .post(`/api/v1/webhooks/payments/${orgId}`)
    .set('Content-Type', 'application/json')
    .set('X-Aggregator-Signature', 'test-mode-any-sig')
    .send(payload);
}

function aggregatorFields(providerEventId: string) {
  return {
    channel: 'CARD',
    providerCustomerId: `cust-${providerEventId}`,
    providerTransactionId: `txn-${providerEventId}`,
  };
}

describe('POST /api/v1/sales/:saleId/payments/online — initiation', () => {
  it('201 — retourne { intentId, paymentLink, expiresAt }, aucun PaymentSale créé', async () => {
    const { saleId, grandTotal } = await createSale();
    expect(grandTotal).toBe('1000');

    const res = await supertest(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/online`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', orgId)
      .send({ amount: '1000' });

    expect(res.status).toBe(201);
    expect(typeof res.body.intentId).toBe('string');
    expect(typeof res.body.paymentLink).toBe('string');
    expect(res.body.paymentLink).toMatch(/^https:\/\/pay\.test\/mock-/);
    expect(typeof res.body.expiresAt).toBe('string');

    const payments = await prisma.paymentSale.findMany({ where: { saleId } });
    expect(payments).toHaveLength(0);

    const intent = await prisma.onlinePaymentIntent.findUnique({ where: { id: res.body.intentId as string } });
    expect(intent!.status).toBe('PENDING');
    expect(intent!.saleId).toBe(saleId);
  });

  it('400 — amount dépasse le solde restant de la vente', async () => {
    const { saleId } = await createSale();

    const res = await supertest(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/online`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', orgId)
      .send({ amount: '5000' });

    expect(res.status).toBe(400);
    const intents = await prisma.onlinePaymentIntent.findMany({ where: { saleId } });
    expect(intents).toHaveLength(0);
  });
});

describe('Webhook payment.success avec intentId — confirmation', () => {
  it("200 — crée PaymentSale + PaymentWithCreditCard, intention CONFIRMED, Sale.status INCHANGÉ (immutabilité, §17 règle 7)", async () => {
    const { saleId, status: statusBefore } = await createSale();
    const initRes = await supertest(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/online`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', orgId)
      .send({ amount: '1000' });
    const intentId = initRes.body.intentId as string;

    const providerEventId = `evt-confirm-${intentId}`;
    const res = await postWebhook({
      type: 'payment.success',
      providerEventId,
      intentId,
      ...aggregatorFields(providerEventId),
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const intent = await prisma.onlinePaymentIntent.findUnique({ where: { id: intentId } });
    expect(intent!.status).toBe('CONFIRMED');
    expect(intent!.paymentSaleId).not.toBeNull();

    const payments = await prisma.paymentSale.findMany({ where: { saleId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.method).toBe('CARD');

    const cardPayments = await prisma.paymentWithCreditCard.findMany({
      where: { paymentSaleId: payments[0]!.id },
    });
    expect(cardPayments).toHaveLength(1);
    expect(cardPayments[0]!.providerTransactionId).toBe(`txn-${providerEventId}`);

    // Décision de conception centrale S31 : Sale.status n'est JAMAIS touché par ce flux —
    // une vente PENDING reste PENDING, une vente COMPLETED resterait COMPLETED.
    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale!.status).toBe(statusBefore);
  }, 15_000);

  it('rejeu du même providerEventId → 200, un seul PaymentSale (idempotence)', async () => {
    const { saleId } = await createSale();
    const initRes = await supertest(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/online`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', orgId)
      .send({ amount: '1000' });
    const intentId = initRes.body.intentId as string;

    const providerEventId = `evt-replay-${intentId}`;
    const payload = {
      type: 'payment.success',
      providerEventId,
      intentId,
      ...aggregatorFields(providerEventId),
    };

    await postWebhook(payload).expect(200);
    await postWebhook(payload).expect(200);

    const payments = await prisma.paymentSale.findMany({ where: { saleId } });
    expect(payments).toHaveLength(1);

    const events = await prisma.webhookEvent.findMany({
      where: { provider: 'payment-aggregator', providerEventId },
    });
    expect(events).toHaveLength(1);
  }, 20_000);
});

describe('Expiration d\'une intention de paiement en ligne — SaleOnlinePaymentService.expirePayment', () => {
  it("EXPIRED, aucune restitution de stock, Sale.status inchangé (découplage total du stock/Sale, S31)", async () => {
    const { saleId, status: statusBefore } = await createSale();
    const initRes = await supertest(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/online`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', orgId)
      .send({ amount: '1000' });
    const intentId = initRes.body.intentId as string;

    const pwBefore = await prisma.productWarehouse.findUnique({ where: { id: pwId } });

    // Appel direct du service plutôt que d'attendre le vrai délai BullMQ (pattern déjà utilisé
    // par pos-payment-expiration.worker.spec.ts) — simule le job d'expiration différé.
    await saleOnlinePaymentService.expirePayment(orgId, intentId);

    const intent = await prisma.onlinePaymentIntent.findUnique({ where: { id: intentId } });
    expect(intent!.status).toBe('EXPIRED');

    const pwAfter = await prisma.productWarehouse.findUnique({ where: { id: pwId } });
    expect(new Decimal(pwAfter!.quantity).toString()).toBe(new Decimal(pwBefore!.quantity).toString());

    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale!.status).toBe(statusBefore);

    const payments = await prisma.paymentSale.findMany({ where: { saleId } });
    expect(payments).toHaveLength(0);
  });

  it('expiration puis confirmation webhook tardive → no-op idempotent, un seul état terminal', async () => {
    const { saleId } = await createSale();
    const initRes = await supertest(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/online`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', orgId)
      .send({ amount: '1000' });
    const intentId = initRes.body.intentId as string;

    await saleOnlinePaymentService.expirePayment(orgId, intentId);

    const providerEventId = `evt-late-${intentId}`;
    const res = await postWebhook({
      type: 'payment.success',
      providerEventId,
      intentId,
      ...aggregatorFields(providerEventId),
    });

    expect(res.status).toBe(200);

    const intent = await prisma.onlinePaymentIntent.findUnique({ where: { id: intentId } });
    expect(intent!.status).toBe('EXPIRED');

    const payments = await prisma.paymentSale.findMany({ where: { saleId } });
    expect(payments).toHaveLength(0);
  }, 15_000);
});
