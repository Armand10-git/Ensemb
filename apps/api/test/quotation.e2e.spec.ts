/**
 * Tests d'intégration Quotation (S28, §18.4).
 *
 * Couvre :
 *  - POST /quotations : 201, référence DEV-…, grandTotal calculé, pas de paymentStatus/paidAmount
 *  - GET /quotations paginé, isolation tenant, records.viewAll
 *  - GET /quotations/:id avec détails/client/entrepôt
 *  - PATCH /quotations/:id — lignes recalculées, uniquement si PENDING
 *  - DELETE /quotations/:id — 204 si PENDING, 400 si COMPLETED
 *  - IDOR : org B ne peut ni lire, ni modifier, ni convertir, ni supprimer un devis de org A
 *  - POST /quotations/:id/convert (S28) : crée une Sale PENDING/UNPAID avec référence VTE-…
 *    (séquence des ventes classiques réutilisée, PAS une séquence DEV dédiée), copie les
 *    lignes, fait passer le devis à COMPLETED, double conversion séquentielle → 400 propre,
 *    double conversion concurrente (Promise.all) → une 201 + une 409 propre (pas de 500,
 *    pas de double Sale créée), 404/403 IDOR, permission manquante → 403.
 *  - POST /quotations/:id/send (S24 mirror) — enfile un job email/sms, 400 si contact client
 *    manquant, 422 si channel invalide, isolation tenant, AuditLog tracé. Le contenu réel du
 *    message est hors périmètre (déjà testé dans quotation-message.renderer.spec.ts et les
 *    specs des workers).
 *  - LE TEST CRITIQUE bout en bout (critère « Fait quand » de la session) : devis → conversion
 *    → PATCH /sales/:id/validate (route SaleController EXISTANTE, S21, non modifiée) → stock
 *    décrémenté exactement comme n'importe quelle autre vente PENDING — preuve qu'AUCUN
 *    traitement spécial n'a été ajouté à SaleService pour une vente issue d'une conversion.
 *    Vérifie aussi qu'aucun mouvement de stock n'a lieu ni à la création du devis, ni à sa
 *    conversion (§18.4 : un devis ne réserve jamais de stock).
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
import { QuotationsModule } from '../src/modules/quotations/quotation.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-quot-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-quot-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;        // Admin org A — a toutes les permissions quotations.*/sales.* + records.viewAll
let tokenA2: string;       // Utilisateur org A sans records.viewAll
let tokenANoConvert: string; // Utilisateur org A sans quotations.convert
let tokenB: string;
let clientAId: string;
let warehouseAId: string;
let productAId: string;
let pwValId: string; // ProductWarehouse dédié au test bout en bout (productAId @ warehouseAId)

const PERMS = [
  'quotations.view',
  'quotations.create',
  'quotations.edit',
  'quotations.delete',
  'quotations.convert',
  'sales.view',
  'sales.create',
  'sales.validate',
  'records.viewAll',
];
const PERMS_NO_VIEWALL = [
  'quotations.view',
  'quotations.create',
  'quotations.edit',
  'quotations.delete',
  'quotations.convert',
  'sales.view',
  'sales.create',
  'sales.validate',
];
const PERMS_NO_CONVERT = [
  'quotations.view',
  'quotations.create',
  'quotations.edit',
  'quotations.delete',
  'sales.view',
  'sales.create',
  'sales.validate',
  'records.viewAll',
];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E Quotation Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Quotation Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  const allPerms = [...new Set([...PERMS, ...PERMS_NO_VIEWALL, ...PERMS_NO_CONVERT])];
  for (const name of allPerms) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const permsFull = await prisma.permission.findMany({ where: { name: { in: PERMS } }, select: { id: true } });
  const permsNoViewAll = await prisma.permission.findMany({
    where: { name: { in: PERMS_NO_VIEWALL } },
    select: { id: true },
  });
  const permsNoConvert = await prisma.permission.findMany({
    where: { name: { in: PERMS_NO_CONVERT } },
    select: { id: true },
  });

  async function setupUser(orgId: string, email: string, roleName: string, permIds: { id: string }[]) {
    const role = await prisma.role.create({ data: { organizationId: orgId, name: roleName } });
    for (const p of permIds) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Test',
        lastname: 'Quotation',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  await setupUser(orgAId, `quot-a-${SUFFIX}@e2e.cm`, 'Admin', permsFull);
  await setupUser(orgAId, `quot-a2-${SUFFIX}@e2e.cm`, 'Vendeur', permsNoViewAll);
  await setupUser(orgAId, `quot-a3-${SUFFIX}@e2e.cm`, 'VendeurSansConvert', permsNoConvert);
  await setupUser(orgBId, `quot-b-${SUFFIX}@e2e.cm`, 'Admin', permsFull);

  // Données de base pour org A
  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-QUOT-${SUFFIX}`, name: 'Cat Quotation A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-QUOT-${SUFFIX}`,
      name: 'Produit Devis A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH Quot-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  const clientA = await prisma.client.create({
    data: { organizationId: orgAId, name: `Client Quotation ${SUFFIX}`, code: 1 },
  });
  clientAId = clientA.id;

  // Stock initial dédié au test bout en bout (conversion → validate()). Remis à l'état voulu
  // juste avant ce test précis, comme pwValId dans sale.e2e.spec.ts.
  const pwVal = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('50'), version: 0 },
  });
  pwValId = pwVal.id;

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
      QuotationsModule,
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

  tokenA          = await login(orgAId, `quot-a-${SUFFIX}@e2e.cm`);
  tokenA2         = await login(orgAId, `quot-a2-${SUFFIX}@e2e.cm`);
  tokenANoConvert = await login(orgAId, `quot-a3-${SUFFIX}@e2e.cm`);
  tokenB          = await login(orgBId, `quot-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  // Nettoyage dans l'ordre des FK
  await prisma.saleDetail.deleteMany({ where: { sale: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.sale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.quotationDetail.deleteMany({ where: { quotation: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.quotation.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
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

// ─── Helpers requête authentifiée ──────────────────────────────────────────────

function asA(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenA}`)
    .set('X-Organization-Id', orgAId);
}
function asA2(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenA2}`)
    .set('X-Organization-Id', orgAId);
}
function asANoConvert(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenANoConvert}`)
    .set('X-Organization-Id', orgAId);
}
function asB(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenB}`)
    .set('X-Organization-Id', orgBId);
}

async function createQuotation(quantity = '2', price = '1000') {
  return asA('post', '/api/v1/quotations').send({
    clientId: clientAId,
    warehouseId: warehouseAId,
    date: '2026-07-26T00:00:00.000Z',
    details: [{ productId: productAId, price, quantity }],
  });
}

// ─── POST /quotations ────────────────────────────────────────────────────────

describe('POST /api/v1/quotations', () => {
  it('201 — crée un devis PENDING avec référence DEV-… et grandTotal correct, sans paymentStatus/paidAmount', async () => {
    const res = await asA('post', '/api/v1/quotations').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      taxRate: '10',
      discount: '100',
      shipping: '50',
      details: [{ productId: productAId, price: '1000', quantity: '2' }],
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.reference).toMatch(/^DEV-\d{4}-\d+$/);
    // sumLines = 2000, taxGlobal = 200, discount = 100, shipping = 50 → 2150
    expect(res.body.grandTotal).toBe('2150');
    expect(res.body).not.toHaveProperty('paymentStatus');
    expect(res.body).not.toHaveProperty('paidAmount');

    const inDb = await prisma.quotation.findUnique({ where: { id: res.body.id } });
    expect(inDb!.grandTotal.toString()).toBe('2150');
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/quotations')
      .set('X-Organization-Id', orgAId)
      .send({});
    expect(res.status).toBe(401);
  });

  it('422 — payload invalide (details vide)', async () => {
    const res = await asA('post', '/api/v1/quotations').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [],
    });
    expect(res.status).toBe(422);
  });

  it('isolation — tenant B ne peut pas créer un devis avec un client/entrepôt de tenant A', async () => {
    const res = await asB('post', '/api/v1/quotations').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── GET /quotations — pagination, isolation, records.viewAll ────────────────

describe('GET /api/v1/quotations', () => {
  it('200 — paginé, tenant B ne voit pas les devis de tenant A', async () => {
    await createQuotation();

    const res = await asB('get', '/api/v1/quotations');

    expect(res.status).toBe(200);
    const data = res.body.data as { organizationId: string }[];
    expect(data.every((q) => q.organizationId !== orgAId)).toBe(true);
  });

  it("records.viewAll=false — l'utilisateur ne voit que ses propres devis", async () => {
    const created = await createQuotation('1', '500');
    expect(created.status).toBe(201);

    const res = await asA2('get', '/api/v1/quotations');

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((q) => q.id);
    expect(ids).not.toContain(created.body.id);

    const resAdmin = await asA('get', '/api/v1/quotations');
    const idsAdmin = (resAdmin.body.data as { id: string }[]).map((q) => q.id);
    expect(idsAdmin).toContain(created.body.id);
  });
});

// ─── GET /quotations/:id ───────────────────────────────────────────────────────

describe('GET /api/v1/quotations/:id', () => {
  it('200 — retourne le devis avec ses lignes, client et entrepôt', async () => {
    const created = await createQuotation('3');

    const res = await asA('get', `/api/v1/quotations/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].quantity).toBe('3');
    expect(res.body.client).toBeDefined();
    expect(res.body.client.id).toBe(clientAId);
    expect(res.body.warehouse).toBeDefined();
    expect(res.body.warehouse.id).toBe(warehouseAId);
  });

  it('404 — devis inexistant', async () => {
    const res = await asA('get', '/api/v1/quotations/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('403 — IDOR : org B ne peut pas lire un devis de org A', async () => {
    const created = await createQuotation();
    const res = await asB('get', `/api/v1/quotations/${created.body.id}`);
    expect(res.status).toBe(403);
  });
});

// ─── PATCH /quotations/:id ─────────────────────────────────────────────────────

describe('PATCH /api/v1/quotations/:id', () => {
  it('200 — recalcule les totaux après remplacement des lignes (PENDING)', async () => {
    const created = await createQuotation('1');

    const res = await asA('patch', `/api/v1/quotations/${created.body.id}`)
      .send({ details: [{ productId: productAId, price: '1000', quantity: '5' }] });

    expect(res.status).toBe(200);
    expect(res.body.grandTotal).toBe('5000');
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].quantity).toBe('5');
  });

  it('400 — un devis COMPLETED ne peut pas être modifié', async () => {
    const created = await createQuotation('1');

    const converted = await asA('post', `/api/v1/quotations/${created.body.id}/convert`).send();
    expect(converted.status).toBe(201);

    const res = await asA('patch', `/api/v1/quotations/${created.body.id}`).send({ notes: 'x' });

    expect(res.status).toBe(400);
  });

  it('403 — IDOR : org B ne peut pas modifier un devis de org A', async () => {
    const created = await createQuotation();
    const res = await asB('patch', `/api/v1/quotations/${created.body.id}`).send({ notes: 'x' });
    expect(res.status).toBe(403);
  });
});

// ─── POST /quotations/:id/convert (S28) ────────────────────────────────────────

describe('POST /api/v1/quotations/:id/convert', () => {
  it(
    '201 — cas nominal : devis PENDING → Sale PENDING/UNPAID avec référence VTE-… ' +
      '(pas DEV-…), mêmes lignes, quotationId renseigné, devis COMPLETED après coup',
    async () => {
      const created = await createQuotation('3', '1000');
      const quotationId = created.body.id as string;

      const res = await asA('post', `/api/v1/quotations/${quotationId}/convert`).send();

      expect(res.status).toBe(201);
      expect(res.body.reference).toMatch(/^VTE-\d{4}-\d+$/);
      expect(res.body.reference).not.toMatch(/^DEV-/);
      expect(res.body.status).toBe('PENDING');
      expect(res.body.paymentStatus).toBe('UNPAID');
      expect(res.body.details).toHaveLength(1);
      expect(res.body.details[0].productId).toBe(productAId);
      expect(res.body.details[0].quantity).toBe('3');
      expect(res.body.details[0].price).toBe('1000');
      expect(res.body.details[0].total).toBe('3000');

      const saleId = res.body.id as string;
      const saleInDb = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(saleInDb).not.toBeNull();
      expect(saleInDb!.quotationId).toBe(quotationId);

      const quotationInDb = await prisma.quotation.findUnique({ where: { id: quotationId } });
      expect(quotationInDb!.status).toBe('COMPLETED');
    },
  );

  it('400 — double conversion : le devis est déjà COMPLETED, message explicite (pas un 500)', async () => {
    const created = await createQuotation('1');
    const quotationId = created.body.id as string;

    const first = await asA('post', `/api/v1/quotations/${quotationId}/convert`).send();
    expect(first.status).toBe(201);

    const second = await asA('post', `/api/v1/quotations/${quotationId}/convert`).send();

    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/converti/i);
  });

  it(
    'concurrence — deux conversions simultanées sur le même devis PENDING : exactement ' +
      'une 201, l\'autre 409 (pas de double conversion, pas de 500 opaque)',
    async () => {
      const created = await createQuotation('1');
      const quotationId = created.body.id as string;

      const [res1, res2] = await Promise.all([
        asA('post', `/api/v1/quotations/${quotationId}/convert`).send(),
        asA('post', `/api/v1/quotations/${quotationId}/convert`).send(),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      const conflictBody = res1.status === 409 ? res1.body : res2.body;
      expect(conflictBody.message).toMatch(/converti/i);

      const salesForQuotation = await prisma.sale.findMany({ where: { quotationId } });
      expect(salesForQuotation).toHaveLength(1);
    },
  );

  it('404 — devis introuvable', async () => {
    const res = await asA('post', '/api/v1/quotations/00000000-0000-0000-0000-000000000000/convert').send();
    expect(res.status).toBe(404);
  });

  it('403 — IDOR : org B ne peut pas convertir un devis de org A', async () => {
    const created = await createQuotation();
    const quotationId = created.body.id as string;

    const res = await asB('post', `/api/v1/quotations/${quotationId}/convert`).send();
    expect(res.status).toBe(403);

    const quotationInDb = await prisma.quotation.findUnique({ where: { id: quotationId } });
    expect(quotationInDb!.status).toBe('PENDING');
  });

  it('403 — permission quotations.convert manquante', async () => {
    const created = await createQuotation();
    const quotationId = created.body.id as string;

    const res = await asANoConvert('post', `/api/v1/quotations/${quotationId}/convert`).send();
    expect(res.status).toBe(403);

    const quotationInDb = await prisma.quotation.findUnique({ where: { id: quotationId } });
    expect(quotationInDb!.status).toBe('PENDING');
  });
});

// ─── POST /quotations/:id/send (S24 mirror) ────────────────────────────────────

describe('POST /api/v1/quotations/:id/send', () => {
  let clientContactId: string;

  beforeAll(async () => {
    const client = await prisma.client.create({
      data: {
        organizationId: orgAId,
        name: `Client Quotation Contact ${SUFFIX}`,
        code: 2,
        email: `client-quot-send-${SUFFIX}@e2e.cm`,
        phone: '+237690000001',
      },
    });
    clientContactId = client.id;
  });

  async function createQuotationForClient(clientId: string): Promise<string> {
    const created = await asA('post', '/api/v1/quotations').send({
      clientId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    return created.body.id as string;
  }

  it('202 — channel email, client avec email renseigné → job enfilé', async () => {
    const quotationId = await createQuotationForClient(clientContactId);

    const res = await asA('post', `/api/v1/quotations/${quotationId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it("400 — channel email, client sans adresse email enregistrée", async () => {
    const quotationId = await createQuotationForClient(clientAId);

    const res = await asA('post', `/api/v1/quotations/${quotationId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(400);
  });

  it('422 — channel absent ou invalide', async () => {
    const quotationId = await createQuotationForClient(clientContactId);

    const resMissing = await asA('post', `/api/v1/quotations/${quotationId}/send`).send({});
    expect(resMissing.status).toBe(422);

    const resInvalid = await asA('post', `/api/v1/quotations/${quotationId}/send`).send({ channel: 'fax' });
    expect(resInvalid.status).toBe(422);
  });

  it('403 — isolation tenant : org B ne peut pas envoyer un devis de org A', async () => {
    const quotationId = await createQuotationForClient(clientContactId);

    const res = await asB('post', `/api/v1/quotations/${quotationId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(403);
  });

  it('202 — AuditLog tracé (action quotations.send) après un envoi réussi', async () => {
    const quotationId = await createQuotationForClient(clientContactId);

    const res = await asA('post', `/api/v1/quotations/${quotationId}/send`).send({ channel: 'email' });
    expect(res.status).toBe(202);

    // AuditInterceptor persiste l'AuditLog en fire-and-forget (void, non attendu par la
    // réponse HTTP) — mêmes précautions que sale.e2e.spec.ts (POST /sales/:id/send).
    await new Promise((r) => setTimeout(r, 200));

    const auditLog = await prisma.auditLog.findFirst({
      where: { entity: 'Quotation', entityId: quotationId, action: 'quotations.send' },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog!.actorType).toBe('USER');
  });
});

// ─── DELETE /quotations/:id ─────────────────────────────────────────────────────

describe('DELETE /api/v1/quotations/:id', () => {
  it('204 — supprime un devis PENDING', async () => {
    const created = await createQuotation();

    const res = await asA('delete', `/api/v1/quotations/${created.body.id}`);

    expect(res.status).toBe(204);
  });

  it('400 — un devis COMPLETED ne peut pas être supprimé', async () => {
    const created = await createQuotation();
    const quotationId = created.body.id as string;

    const converted = await asA('post', `/api/v1/quotations/${quotationId}/convert`).send();
    expect(converted.status).toBe(201);

    const res = await asA('delete', `/api/v1/quotations/${quotationId}`);

    expect(res.status).toBe(400);
  });

  it('403 — IDOR : org B ne peut pas supprimer un devis de org A', async () => {
    const created = await createQuotation();
    const res = await asB('delete', `/api/v1/quotations/${created.body.id}`);
    expect(res.status).toBe(403);

    const quotationInDb = await prisma.quotation.findUnique({ where: { id: created.body.id as string } });
    expect(quotationInDb!.deletedAt).toBeNull();
  });
});

// ─── TEST CRITIQUE — bout en bout devis → conversion → validation → stock décrémenté ─────
// Critère « Fait quand » de la session S28 (§18.4) : la Sale issue de la conversion suit
// EXACTEMENT le cycle normal S19-S21, sans aucun code spécial dans SaleService. Utilise la
// route PATCH /sales/:id/validate EXISTANTE (S21, non modifiée par cette session).

describe('Bout en bout — devis → convert() → PATCH /sales/:id/validate → stock décrémenté', () => {
  it(
    'un devis ne mouvemente jamais le stock (ni à la création, ni à la conversion) ; seule ' +
      "la validation de la Sale issue de la conversion décrémente ProductWarehouse.quantity, " +
      'exactement comme une vente créée directement (aucun traitement spécial dans SaleService)',
    async () => {
      // Stock initial connu, dédié à ce test précis.
      await prisma.productWarehouse.update({
        where: { id: pwValId },
        data: { quantity: new Decimal('50'), version: 0 },
      });

      // 1. Création du devis — quantité 5 sur le produit à stock dédié.
      const created = await asA('post', '/api/v1/quotations').send({
        clientId: clientAId,
        warehouseId: warehouseAId,
        date: '2026-07-26T00:00:00.000Z',
        details: [{ productId: productAId, price: '1000', quantity: '5' }],
      });
      expect(created.status).toBe(201);
      const quotationId = created.body.id as string;

      // Aucun mouvement de stock à la création du devis — §18.4 point le plus important.
      let pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
      expect(new Decimal(pw!.quantity).toString()).toBe('50');

      // 2. Conversion du devis en vente.
      const converted = await asA('post', `/api/v1/quotations/${quotationId}/convert`).send();
      expect(converted.status).toBe(201);
      const saleId = converted.body.id as string;
      expect(converted.body.status).toBe('PENDING');
      expect(converted.body.paymentStatus).toBe('UNPAID');

      // Aucun mouvement de stock à la conversion non plus — la conversion elle-même ne
      // mouvemente rien.
      pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
      expect(new Decimal(pw!.quantity).toString()).toBe('50');

      // 3. Validation de la Sale issue de la conversion — route SaleController EXISTANTE,
      // réutilisée telle quelle.
      const validated = await asA('patch', `/api/v1/sales/${saleId}/validate`).send();
      expect(validated.status).toBe(200);
      expect(validated.body.status).toBe('COMPLETED');

      // Preuve du critère « Fait quand » : le stock est décrémenté exactement comme n'importe
      // quelle autre vente PENDING — 50 - 5 = 45.
      pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
      expect(new Decimal(pw!.quantity).toString()).toBe('45');

      const saleInDb = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(saleInDb!.status).toBe('COMPLETED');
      expect(saleInDb!.quotationId).toBe(quotationId);

      // 4. Le devis d'origine reste consultable, statut COMPLETED (§18.4 point 4).
      const quotationRes = await asA('get', `/api/v1/quotations/${quotationId}`);
      expect(quotationRes.status).toBe(200);
      expect(quotationRes.body.status).toBe('COMPLETED');
    },
  );
});
