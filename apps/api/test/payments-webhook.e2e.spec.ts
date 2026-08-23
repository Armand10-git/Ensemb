/**
 * Tests d'intégration — webhook paiement généralisé, POS carte/mobile money (S22, §18.2
 * étape 10 ; généralisé S31, §17 point V).
 *
 * Couvre :
 *  - Confirmation : vente AWAITING_PAYMENT → COMPLETED + PaymentSale + PaymentWithCreditCard créés
 *  - Idempotence : rejeu du même providerEventId → no-op, pas de second PaymentSale
 *  - Vente déjà expirée (CANCELLED) : confirmation tardive → no-op, jamais d'erreur
 *
 * Le pendant vente classique (OnlinePaymentIntent) est couvert par un fichier e2e séparé
 * (sale-online-payment.e2e.spec.ts) — celui-ci se concentre sur le flux POS + le contrat commun
 * du contrôleur webhook généralisé (signature par organisation, idempotence).
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

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_SUBDOMAIN = `e2e-pos-wh-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgId: string;
let token: string;
let clientId: string;
let warehouseId: string;
let productId: string;
let userId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'E2E POS Webhook', subdomain: ORG_SUBDOMAIN } });
  orgId = org.id;

  const permName = 'sales.create';
  await prisma.permission.upsert({ where: { name: permName }, update: {}, create: { name: permName, label: permName } });
  const perm = await prisma.permission.findUniqueOrThrow({ where: { name: permName } });

  const role = await prisma.role.create({ data: { organizationId: orgId, name: 'Caissier' } });
  await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: perm.id } });
  const user = await prisma.user.create({
    data: {
      organizationId: orgId,
      firstname: 'Test',
      lastname: 'PosWebhook',
      email: `pos-wh-${SUFFIX}@e2e.cm`,
      username: `pos-wh-${SUFFIX}@e2e.cm`,
      password: await bcrypt.hash('TestPass!1', 12),
      isActive: true,
    },
  });
  await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
  userId = user.id;

  const cat = await prisma.category.create({
    data: { organizationId: orgId, code: `CAT-POSWH-${SUFFIX}`, name: 'Cat POS Webhook' },
  });
  const prod = await prisma.product.create({
    data: {
      organizationId: orgId,
      code: `PROD-POSWH-${SUFFIX}`,
      name: 'Produit POS Webhook',
      cost: '500',
      price: '1000',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: cat.id,
    },
  });
  productId = prod.id;

  const wh = await prisma.warehouse.create({
    data: { organizationId: orgId, name: `WH POS Webhook-${SUFFIX}`, isDefault: true },
  });
  warehouseId = wh.id;

  const client = await prisma.client.create({
    data: { organizationId: orgId, name: `Client POS Webhook ${SUFFIX}`, code: 1 },
  });
  clientId = client.id;

  await prisma.productWarehouse.create({
    data: { productId, warehouseId, quantity: new Decimal('100'), version: 0 },
  });

  // S23b — PosService.createSale() exige une session de caisse OPEN pour (org, user, warehouse).
  await prisma.cashSession.create({
    data: {
      organizationId: orgId,
      reference: `CS-E2E-WH-${SUFFIX}`,
      warehouseId,
      userId,
      openingAmount: new Decimal('0'),
      status: 'OPEN',
    },
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
      PosModule,
      PaymentGatewayModule,
      PaymentsWebhookModule,
    ],
  }).compile();

  // rawBody: true est indispensable pour le webhook HMAC
  app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api/v1');
  await app.init();

  const res = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgId)
    .send({ email: `pos-wh-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();
  await prisma.webhookEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.paymentWithCreditCard.deleteMany({ where: { organizationId: orgId } });
  await prisma.paymentSale.deleteMany({ where: { organizationId: orgId } });
  await prisma.saleDetail.deleteMany({ where: { sale: { organizationId: orgId } } });
  await prisma.sale.deleteMany({ where: { organizationId: orgId } });
  await prisma.cashSession.deleteMany({ where: { organizationId: orgId } });
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

async function createMobileMoneySale(): Promise<string> {
  const res = await supertest(app.getHttpServer())
    .post('/api/v1/pos/sales')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Organization-Id', orgId)
    .send({
      clientId,
      warehouseId,
      details: [{ productId, price: '1000', quantity: '1' }],
      paymentMethod: 'MOBILE_MONEY',
    });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('AWAITING_PAYMENT');
  return res.body.id as string;
}

function postWebhook(payload: object) {
  return supertest(app.getHttpServer())
    .post(`/api/v1/webhooks/payments/${orgId}`)
    .set('Content-Type', 'application/json')
    .set('X-Aggregator-Signature', 'test-mode-any-sig')
    .send(payload);
}

/** Champs agrégateur requis à la confirmation (S31) — rapportés par le webhook, jamais saisis. */
function aggregatorFields(providerEventId: string) {
  return {
    channel: 'ORANGE_MONEY',
    providerCustomerId: `cust-${providerEventId}`,
    providerTransactionId: `txn-${providerEventId}`,
  };
}

describe('POST /api/v1/webhooks/payments/:organizationId — mobile money POS', () => {
  it('200 — confirme la vente (AWAITING_PAYMENT → COMPLETED), crée PaymentSale + PaymentWithCreditCard', async () => {
    const saleId = await createMobileMoneySale();
    const providerEventId = `evt-confirm-${saleId}`;

    const res = await postWebhook({
      type: 'payment.success',
      providerEventId,
      saleId,
      ...aggregatorFields(providerEventId),
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale!.status).toBe('COMPLETED');

    const payments = await prisma.paymentSale.findMany({ where: { saleId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.method).toBe('MOBILE_MONEY');

    const cardPayments = await prisma.paymentWithCreditCard.findMany({
      where: { paymentSaleId: payments[0]!.id },
    });
    expect(cardPayments).toHaveLength(1);
    expect(cardPayments[0]!.provider).toBe('ORANGE_MONEY');
    expect(cardPayments[0]!.providerTransactionId).toBe(`txn-${providerEventId}`);
  }, 15_000);

  it('rejeu du même providerEventId → 200, un seul PaymentSale (idempotence)', async () => {
    const saleId = await createMobileMoneySale();
    const providerEventId = `evt-replay-${saleId}`;
    const payload = {
      type: 'payment.success',
      providerEventId,
      saleId,
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

  it('vente déjà CANCELLED (expirée) : confirmation tardive → 200 no-op, jamais de PaymentSale', async () => {
    const saleId = await createMobileMoneySale();
    await prisma.sale.update({
      where: { id: saleId },
      data: { status: 'CANCELLED', cancelReason: 'Expiration du délai de paiement mobile money', cancelledAt: new Date() },
    });

    const providerEventId = `evt-late-${saleId}`;
    const res = await postWebhook({
      type: 'payment.success',
      providerEventId,
      saleId,
      ...aggregatorFields(providerEventId),
    });

    expect(res.status).toBe(200);
    const payments = await prisma.paymentSale.findMany({ where: { saleId } });
    expect(payments).toHaveLength(0);
    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale!.status).toBe('CANCELLED');
  }, 15_000);
});
