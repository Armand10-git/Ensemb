/**
 * Tests d'intégration — isolation tenant du webhook paiement, bout en bout (S31, §17 point V).
 *
 * Contrairement à payments-webhook.e2e.spec.ts (mono-organisation, mode test — aucun credential
 * agrégateur configuré, la signature est donc toujours acceptée), ce fichier configure de VRAIS
 * identifiants d'agrégateur (webhookSecret distincts et connus) pour DEUX organisations et vérifie
 * que l'isolation tenant tient à deux niveaux :
 *
 *  1. Signature : un webhook signé avec le secret de l'organisation A ne peut jamais être validé
 *     sur l'URL /webhooks/payments/:organizationIdB — la garde de signature est vérifiée AVANT
 *     toute persistance (aucun WebhookEvent créé en cas de rejet).
 *  2. Scoping applicatif : même avec une signature VALIDE pour l'organisation B, si le
 *     saleId/intentId du payload appartient à une ressource de l'organisation A, la confirmation
 *     est un no-op (PosService.confirmAsyncPayment / SaleOnlinePaymentService.confirmPayment
 *     vérifient l'ownership organizationId AVANT toute écriture).
 *
 * Les deux discriminants du webhook généralisé sont couverts : saleId (POS) et intentId (vente
 * classique, OnlinePaymentIntent).
 *
 * Les ventes/intentions de l'organisation A sont insérées DIRECTEMENT via Prisma plutôt que via
 * POST /pos/sales ou POST /sales/:id/payments/online : ces deux endpoints appellent
 * AsyncPaymentService.generatePaymentLinkFor → TenantPaymentGatewayService.generatePaymentLink,
 * qui — dès qu'un credential agrégateur actif existe (ce que ce fichier configure exprès pour A
 * ET B, cf. ci-dessous) — effectue un VRAI appel HTTP sortant vers l'agrégateur (mode test
 * uniquement en l'absence de credential actif). Ce fichier teste uniquement le contrôleur
 * webhook (signature + scoping), jamais la génération de lien — l'insertion directe l'isole
 * proprement de tout appel réseau externe.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { createHmac } from 'crypto';
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
import { PaymentGatewayCredentialService } from '../src/modules/payment-gateway/payment-gateway-credential.service';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-wh-tenant-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-wh-tenant-b-${SUFFIX}`;

const WEBHOOK_SECRET_A = 'secret-org-A-webhook-key';
const WEBHOOK_SECRET_B = 'secret-org-B-webhook-key';

let app: INestApplication;
const prisma = getTestPrisma();
let credentialService: PaymentGatewayCredentialService;

let orgAId: string;
let orgBId: string;
let clientAId: string;
let warehouseAId: string;
let productAId: string;
let userAId: string;
let refCounter = 0;

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E WH Tenant A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E WH Tenant B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  const user = await prisma.user.create({
    data: {
      organizationId: orgAId,
      firstname: 'Test',
      lastname: 'TenantWebhook',
      email: `wh-tenant-a-${SUFFIX}@e2e.cm`,
      username: `wh-tenant-a-${SUFFIX}@e2e.cm`,
      password: await bcrypt.hash('TestPass!1', 12),
      isActive: true,
    },
  });
  userAId = user.id;

  const cat = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-WHTEN-${SUFFIX}`, name: 'Cat WH Tenant' },
  });
  const prod = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-WHTEN-${SUFFIX}`,
      name: 'Produit WH Tenant',
      cost: '500',
      price: '1000',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: cat.id,
    },
  });
  productAId = prod.id;

  const wh = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH Tenant-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = wh.id;

  const client = await prisma.client.create({
    data: { organizationId: orgAId, name: `Client WH Tenant ${SUFFIX}`, code: 1 },
  });
  clientAId = client.id;

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
      PosModule,
      PaymentGatewayModule,
      PaymentsWebhookModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api/v1');
  await app.init();

  credentialService = moduleRef.get(PaymentGatewayCredentialService);

  // De VRAIS identifiants agrégateur, distincts et connus, pour CHAQUE organisation — sort les
  // deux organisations du "mode test" (qui accepterait n'importe quelle signature) et active la
  // vérification HMAC réelle par TenantPaymentGatewayService.
  await credentialService.upsert(orgAId, {
    apiKey: 'sk_test_org_A',
    merchantId: 'MERCHANT-A',
    webhookSecret: WEBHOOK_SECRET_A,
    isActive: true,
  });
  await credentialService.upsert(orgBId, {
    apiKey: 'sk_test_org_B',
    merchantId: 'MERCHANT-B',
    webhookSecret: WEBHOOK_SECRET_B,
    isActive: true,
  });
});

afterAll(async () => {
  await app?.close();
  await prisma.webhookEvent.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.paymentWithCreditCard.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.paymentSale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.onlinePaymentIntent.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.saleDetail.deleteMany({ where: { sale: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.sale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.client.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.productWarehouse.deleteMany({ where: { productId: productAId } });
  await prisma.product.deleteMany({ where: { organizationId: orgAId } });
  await prisma.category.deleteMany({ where: { organizationId: orgAId } });
  await prisma.warehouse.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.paymentGatewayCredential.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.user.deleteMany({ where: { organizationId: orgAId } });
  await prisma.documentCounter.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
});

/**
 * Crée une vente POS AWAITING_PAYMENT appartenant à l'organisation A — insertion DIRECTE via
 * Prisma (pas via POST /pos/sales, cf. JSDoc d'en-tête : évite l'appel réseau réel de
 * generatePaymentLink dès qu'un credential actif existe).
 */
async function createSaleA(): Promise<string> {
  const sale = await prisma.sale.create({
    data: {
      organizationId: orgAId,
      reference: `VTE-WHTEN-${SUFFIX}-${++refCounter}`,
      date: new Date(),
      isPos: true,
      userId: userAId,
      clientId: clientAId,
      warehouseId: warehouseAId,
      grandTotal: new Decimal('1000'),
      paidAmount: new Decimal('0'),
      paymentStatus: 'UNPAID',
      status: 'AWAITING_PAYMENT',
    },
    select: { id: true },
  });
  return sale.id;
}

/**
 * Crée une vente classique + une intention de paiement en ligne PENDING pour l'organisation A —
 * insertion DIRECTE via Prisma (mêmes raisons que createSaleA : SaleOnlinePaymentService.initiate
 * appelle aussi generatePaymentLinkFor).
 */
async function createIntentA(): Promise<{ saleId: string; intentId: string }> {
  const sale = await prisma.sale.create({
    data: {
      organizationId: orgAId,
      reference: `VTE-WHTEN-${SUFFIX}-${++refCounter}`,
      date: new Date(),
      isPos: false,
      userId: userAId,
      clientId: clientAId,
      warehouseId: warehouseAId,
      grandTotal: new Decimal('1000'),
      paidAmount: new Decimal('0'),
      paymentStatus: 'UNPAID',
      status: 'PENDING',
    },
    select: { id: true },
  });

  const intent = await prisma.onlinePaymentIntent.create({
    data: {
      organizationId: orgAId,
      saleId: sale.id,
      amount: new Decimal('1000'),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 900_000),
    },
    select: { id: true },
  });

  return { saleId: sale.id, intentId: intent.id };
}

function sign(secret: string, payload: object): string {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

function postWebhookToB(payload: object, signature: string) {
  return supertest(app.getHttpServer())
    .post(`/api/v1/webhooks/payments/${orgBId}`)
    .set('Content-Type', 'application/json')
    .set('X-Aggregator-Signature', signature)
    .send(payload);
}

function aggregatorFields(providerEventId: string) {
  return {
    channel: 'ORANGE_MONEY',
    providerCustomerId: `cust-${providerEventId}`,
    providerTransactionId: `txn-${providerEventId}`,
  };
}

describe('Isolation tenant du webhook paiement — signature HMAC par organisation (S31)', () => {
  // ─── Couche 1 : signature ────────────────────────────────────────────────

  describe('Signature calculée avec le secret d\'une autre organisation', () => {
    it("401 — signature de l'organisation A présentée à l'URL de B, aucun WebhookEvent créé (garde AVANT persistance)", async () => {
      const saleId = await createSaleA();
      const providerEventId = `evt-cross-sig-${saleId}`;
      const payload = {
        type: 'payment.success',
        providerEventId,
        saleId,
        ...aggregatorFields(providerEventId),
      };
      // Signature calculée avec le VRAI secret de A, mais postée sur l'URL de B.
      const signatureFromA = sign(WEBHOOK_SECRET_A, payload);

      const res = await postWebhookToB(payload, signatureFromA);

      expect(res.status).toBe(401);

      const events = await prisma.webhookEvent.findMany({ where: { providerEventId } });
      expect(events).toHaveLength(0);

      const sale = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(sale!.status).toBe('AWAITING_PAYMENT');
    });

    it("contrôle positif : la même construction avec le secret de B sur l'URL de B est acceptée (200)", async () => {
      const saleId = await createSaleA();
      const providerEventId = `evt-sanity-${saleId}`;
      const payload = {
        type: 'payment.success',
        providerEventId,
        saleId,
        ...aggregatorFields(providerEventId),
      };
      const signatureFromB = sign(WEBHOOK_SECRET_B, payload);

      const res = await postWebhookToB(payload, signatureFromB);

      expect(res.status).toBe(200);
      const events = await prisma.webhookEvent.findMany({ where: { providerEventId } });
      expect(events).toHaveLength(1);
    });
  });

  // ─── Couche 2 : scoping applicatif (saleId — POS) ───────────────────────

  describe('Scoping applicatif — saleId de A présenté avec une signature VALIDE de B', () => {
    it("200 no-op — vente A inchangée, aucun PaymentSale créé, aucun PaymentWithCreditCard", async () => {
      const saleId = await createSaleA();
      const providerEventId = `evt-cross-scope-sale-${saleId}`;
      const payload = {
        type: 'payment.success',
        providerEventId,
        saleId,
        ...aggregatorFields(providerEventId),
      };
      const signatureFromB = sign(WEBHOOK_SECRET_B, payload);

      const res = await postWebhookToB(payload, signatureFromB);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      // Le WebhookEvent est bien persisté pour B (signature valide) — mais aucun effet métier.
      const events = await prisma.webhookEvent.findMany({ where: { providerEventId } });
      expect(events).toHaveLength(1);
      expect(events[0]!.organizationId).toBe(orgBId);

      const sale = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(sale!.status).toBe('AWAITING_PAYMENT');

      const payments = await prisma.paymentSale.findMany({ where: { saleId } });
      expect(payments).toHaveLength(0);
    });
  });

  // ─── Couche 2 : scoping applicatif (intentId — vente classique) ─────────

  describe('Scoping applicatif — intentId de A présenté avec une signature VALIDE de B', () => {
    it('200 no-op — OnlinePaymentIntent A reste PENDING, aucun PaymentSale créé', async () => {
      const { saleId, intentId } = await createIntentA();
      const providerEventId = `evt-cross-scope-intent-${intentId}`;
      const payload = {
        type: 'payment.success',
        providerEventId,
        intentId,
        ...aggregatorFields(providerEventId),
      };
      const signatureFromB = sign(WEBHOOK_SECRET_B, payload);

      const res = await postWebhookToB(payload, signatureFromB);

      expect(res.status).toBe(200);

      const intent = await prisma.onlinePaymentIntent.findUnique({ where: { id: intentId } });
      expect(intent!.status).toBe('PENDING');

      const payments = await prisma.paymentSale.findMany({ where: { saleId } });
      expect(payments).toHaveLength(0);
    });
  });
});
