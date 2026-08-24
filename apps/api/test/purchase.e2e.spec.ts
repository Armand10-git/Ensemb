/**
 * Tests d'intégration Purchase (S25 — Bloc F, mirror exact du patron sale.e2e.spec.ts).
 *
 * Couvre :
 *  - Création d'un achat PENDING (POST → 201), référence ACH-…, grandTotal en base
 *    (calcul Decimal percentage et fixed), isolation tenant (IDOR provider/entrepôt/produit)
 *  - GET /purchases paginé, filtres, isolation multi-tenant, records.viewAll
 *  - GET /purchases/:id avec lignes/fournisseur/entrepôt
 *  - PATCH /purchases/:id — recalcul des totaux, refusé si COMPLETED
 *  - DELETE /purchases/:id — 204 si PENDING, 400 si COMPLETED
 *  - PATCH /purchases/:id/validate (S25) — incrémente ProductWarehouse.quantity, conversion
 *    d'unité (purchaseUnitId), PENDING → COMPLETED, refusé si déjà COMPLETED, isolation tenant,
 *    et le cas spécifique à Purchase (absent de Sale) : ProductWarehouse inexistant avant
 *    validate() → créé automatiquement avec la quantité exacte.
 *  - Le test de concurrence "lost update" : deux validate() simultanés sur le MÊME
 *    ProductWarehouse doivent TOUS LES DEUX réussir (200/200), quantité finale = somme exacte
 *    des deux incréments — à la différence du test de concurrence S21 sur les ventes (un seul
 *    gagnant, 200/409), car un incrément est toujours fusionnable (aucune décision métier
 *    perdue à retenter). C'est le retry automatique borné de PurchaseService.validate()
 *    (TÂCHE 1 de cette session) qui rend ce test vert : sans lui, l'une des deux requêtes
 *    échouerait par intermittence avec un 409 (conflit de version optimiste ou de
 *    sérialisation Postgres P2034 sur le même ProductWarehouse).
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
import { PurchasesModule } from '../src/modules/purchases/purchase.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-purchase-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-purchase-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;        // Admin org A — a records.viewAll
let tokenA2: string;       // Utilisateur org A sans records.viewAll
let tokenB: string;
let providerAId: string;
let warehouseAId: string;
let productAId: string;
let unitPieceId: string;   // unité de stock du produit (base)
let unitCartonId: string;  // unité d'achat dérivée : 1 carton = 12 pièces
let pwValId: string;       // ProductWarehouse dédié aux tests de validate() (productAId @ warehouseAId)

const PERMS = [
  'purchases.view', 'purchases.create', 'purchases.edit', 'purchases.delete', 'purchases.validate',
  'paymentPurchases.view', 'paymentPurchases.create',
  'records.viewAll',
];
const PERMS_NO_VIEWALL = ['purchases.view', 'purchases.create', 'purchases.edit', 'purchases.delete'];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E Purchase Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Purchase Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  const allPerms = [...new Set([...PERMS, ...PERMS_NO_VIEWALL])];
  for (const name of allPerms) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const permsFull = await prisma.permission.findMany({ where: { name: { in: PERMS } }, select: { id: true } });
  const permsNoViewAll = await prisma.permission.findMany({
    where: { name: { in: PERMS_NO_VIEWALL } },
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
        lastname: 'Purchase',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  await setupUser(orgAId, `purchase-a-${SUFFIX}@e2e.cm`, 'Admin', permsFull);
  await setupUser(orgAId, `purchase-a2-${SUFFIX}@e2e.cm`, 'Acheteur', permsNoViewAll);
  await setupUser(orgBId, `purchase-b-${SUFFIX}@e2e.cm`, 'Admin', permsFull);

  // Données de base pour org A
  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-PURCH-${SUFFIX}`, name: 'Cat Purchase A' },
  });

  const unitPiece = await prisma.unit.create({
    data: { organizationId: orgAId, name: `Piece-${SUFFIX}`, shortName: 'pcs', operator: '*', operatorValue: new Decimal('1') },
  });
  unitPieceId = unitPiece.id;
  const unitCarton = await prisma.unit.create({
    data: {
      organizationId: orgAId,
      name: `Carton-${SUFFIX}`,
      shortName: 'ctn',
      baseUnitId: unitPieceId,
      operator: '*',
      operatorValue: new Decimal('12'),
    },
  });
  unitCartonId = unitCarton.id;

  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-PURCH-${SUFFIX}`,
      name: 'Produit Achat A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
      unitId: unitPieceId,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH Purchase-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  const providerA = await prisma.provider.create({
    data: { organizationId: orgAId, name: `Fournisseur Purchase ${SUFFIX}`, code: 1 },
  });
  providerAId = providerA.id;

  // Stock initial pour les tests validate() — remis à l'état voulu au début de chaque test.
  const pwVal = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('100'), version: 0 },
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
      PurchasesModule,
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

  tokenA  = await login(orgAId, `purchase-a-${SUFFIX}@e2e.cm`);
  tokenA2 = await login(orgAId, `purchase-a2-${SUFFIX}@e2e.cm`);
  tokenB  = await login(orgBId, `purchase-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  // Nettoyage dans l'ordre des FK
  await prisma.paymentPurchase.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.purchaseDetail.deleteMany({ where: { purchase: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.purchase.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.provider.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.productWarehouse.deleteMany({ where: { productId: productAId } });
  await prisma.product.deleteMany({ where: { organizationId: orgAId } });
  await prisma.unit.deleteMany({ where: { organizationId: orgAId } });
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
// TenancyMiddleware exige un contexte tenant résolu (header X-Organization-Id en
// dev/CLI, cf. tenancy.middleware.ts) sur toute route non exemptée ; JwtAuthGuard
// vérifie ensuite que ce tenant correspond bien à l'organisation du token (anti-IDOR
// inter-tenant, cf. jwt-auth.guard.ts).

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
function asB(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenB}`)
    .set('X-Organization-Id', orgBId);
}

// ─── POST /purchases ────────────────────────────────────────────────────────

describe('POST /api/v1/purchases', () => {
  it('201 — crée un achat PENDING avec référence ACH-… et grandTotal correct (percentage)', async () => {
    const res = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      taxRate: '10',
      discount: '100',
      shipping: '50',
      details: [{ productId: productAId, price: '1000', quantity: '2' }],
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.paymentStatus).toBe('UNPAID');
    expect(res.body.reference).toMatch(/^ACH-\d{4}-\d+$/);
    // sumLines = 2000, taxGlobal = 200, discount = 100, shipping = 50 → 2150
    expect(res.body.grandTotal).toBe('2150');

    const inDb = await prisma.purchase.findUnique({ where: { id: res.body.id } });
    expect(inDb!.grandTotal.toString()).toBe('2150');
  });

  it('201 — calcul Decimal en mode fixed sur une ligne (taxe et remise fixes)', async () => {
    const res = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [
        {
          productId: productAId,
          price: '1000',
          quantity: '2',
          taxAmount: '50',
          taxMethod: 'fixed',
          discount: '30',
          discountMethod: 'fixed',
        },
      ],
    });

    expect(res.status).toBe(201);
    // subTotal = 2000, taxe fixe = 50, remise fixe = 30 → total ligne = 2020
    expect(res.body.details[0].total).toBe('2020');
    expect(res.body.grandTotal).toBe('2020');
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/purchases')
      .set('X-Organization-Id', orgAId)
      .send({});
    expect(res.status).toBe(401);
  });

  it('422 — payload invalide (details vide)', async () => {
    const res = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [],
    });
    expect(res.status).toBe(422);
  });

  it('IDOR — tenant B ne peut pas créer un achat avec un fournisseur/entrepôt/produit de tenant A', async () => {
    const resProvider = await asB('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    expect(resProvider.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── GET /purchases — pagination, filtres, isolation, records.viewAll ────────

describe('GET /api/v1/purchases', () => {
  it('200 — paginé, tenant B ne voit pas les achats de tenant A', async () => {
    await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    const res = await asB('get', '/api/v1/purchases');

    expect(res.status).toBe(200);
    const data = res.body.data as { organizationId: string }[];
    expect(data.every((p) => p.organizationId !== orgAId)).toBe(true);
  });

  it('200 — filtre par providerId', async () => {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    const res = await asA('get', `/api/v1/purchases?providerId=${providerAId}`);

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(created.body.id);
  });

  it("records.viewAll=false — l'utilisateur ne voit que ses propres achats", async () => {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '500', quantity: '1' }],
    });
    expect(created.status).toBe(201);

    const res = await asA2('get', '/api/v1/purchases');
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(created.body.id);

    const resAdmin = await asA('get', '/api/v1/purchases');
    const idsAdmin = (resAdmin.body.data as { id: string }[]).map((p) => p.id);
    expect(idsAdmin).toContain(created.body.id);
  });
});

// ─── GET /purchases/:id ───────────────────────────────────────────────────────

describe('GET /api/v1/purchases/:id', () => {
  it('200 — retourne l\'achat avec ses lignes, fournisseur et entrepôt', async () => {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '3' }],
    });

    const res = await asA('get', `/api/v1/purchases/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].quantity).toBe('3');
    expect(res.body.provider.id).toBe(providerAId);
    expect(res.body.warehouse.id).toBe(warehouseAId);
  });

  it('403 — isolation tenant : org B ne peut pas lire un achat de org A', async () => {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    const res = await asB('get', `/api/v1/purchases/${created.body.id}`);
    expect(res.status).toBe(403);
  });
});

// ─── PATCH /purchases/:id ─────────────────────────────────────────────────────

describe('PATCH /api/v1/purchases/:id', () => {
  it('200 — recalcule les totaux après remplacement des lignes (PENDING)', async () => {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    const res = await asA('patch', `/api/v1/purchases/${created.body.id}`)
      .send({ details: [{ productId: productAId, price: '1000', quantity: '5' }] });

    expect(res.status).toBe(200);
    expect(res.body.grandTotal).toBe('5000');
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].quantity).toBe('5');
  });

  it('400 — un achat COMPLETED ne peut pas être modifié', async () => {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    await prisma.purchase.update({ where: { id: created.body.id as string }, data: { status: 'COMPLETED' } });

    const res = await asA('patch', `/api/v1/purchases/${created.body.id}`).send({ notes: 'x' });

    expect(res.status).toBe(400);
  });
});

// ─── DELETE /purchases/:id ────────────────────────────────────────────────────

describe('DELETE /api/v1/purchases/:id', () => {
  it('204 — supprime un achat PENDING', async () => {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    const res = await asA('delete', `/api/v1/purchases/${created.body.id}`);

    expect(res.status).toBe(204);
  });

  it('400 — un achat COMPLETED ne peut pas être supprimé', async () => {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    await prisma.purchase.update({ where: { id: created.body.id as string }, data: { status: 'COMPLETED' } });

    const res = await asA('delete', `/api/v1/purchases/${created.body.id}`);

    expect(res.status).toBe(400);
  });
});

// ─── PATCH /purchases/:id/validate (S25) ──────────────────────────────────────
// Mouvemente le stock (ProductWarehouse.quantity, incrément, verrouillage optimiste,
// transaction Serializable) puis fait passer le statut PENDING → COMPLETED. Chaque test
// remet le stock partagé (pwValId) à l'état voulu avant de créer son propre achat, à
// l'identique du patron sale.e2e.spec.ts.

describe('PATCH /api/v1/purchases/:id/validate', () => {
  it('200 — incrémente ProductWarehouse.quantity et passe status à COMPLETED', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('100'), version: 0 },
    });

    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '4' }],
    });
    const purchaseId = created.body.id as string;

    const res = await asA('patch', `/api/v1/purchases/${purchaseId}/validate`).send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('104');

    const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId } });
    expect(purchase!.status).toBe('COMPLETED');
  });

  it('200 — conversion d\'unité purchaseUnitId : 2 cartons × 12 = 24 pièces incrémentées', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('50'), version: 0 },
    });

    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '2', purchaseUnitId: unitCartonId }],
    });
    const purchaseId = created.body.id as string;

    const res = await asA('patch', `/api/v1/purchases/${purchaseId}/validate`).send();

    expect(res.status).toBe(200);
    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('74'); // 50 + (2 × 12)
  });

  it('400 — un achat déjà COMPLETED ne peut pas être revalidé', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('50'), version: 0 },
    });

    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    const purchaseId = created.body.id as string;

    const first = await asA('patch', `/api/v1/purchases/${purchaseId}/validate`).send();
    expect(first.status).toBe(200);

    const second = await asA('patch', `/api/v1/purchases/${purchaseId}/validate`).send();
    expect(second.status).toBe(400);

    // Pas de double incrément : 50 + 1 (une seule validation effective) = 51, jamais 52.
    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('51');
  });

  it('403 — isolation tenant : org B ne peut pas valider un achat de org A', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('50'), version: 0 },
    });

    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    const purchaseId = created.body.id as string;

    const res = await asB('patch', `/api/v1/purchases/${purchaseId}/validate`).send();

    expect(res.status).toBe(403);

    // Le stock et le statut de org A restent inchangés — l'échec de org B n'a aucun effet.
    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('50');
    const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId } });
    expect(purchase!.status).toBe('PENDING');
  });

  it('200 — ProductWarehouse absent avant validate() → créé automatiquement avec la quantité exacte (spécifique à Purchase, absent de Sale)', async () => {
    // Produit dédié à ce test, jamais reçu dans cet entrepôt — aucun ProductWarehouse existant.
    const catB = await prisma.category.create({
      data: { organizationId: orgAId, code: `CAT-PURCH-NEW-${SUFFIX}`, name: 'Cat Purchase Nouveau' },
    });
    const newProduct = await prisma.product.create({
      data: {
        organizationId: orgAId,
        code: `PROD-PURCH-NEW-${SUFFIX}`,
        name: 'Produit Achat Nouveau',
        cost: '500',
        price: '800',
        taxRate: '0',
        taxMethod: 'percentage',
        categoryId: catB.id,
        unitId: unitPieceId,
      },
    });

    const existing = await prisma.productWarehouse.findFirst({
      where: { productId: newProduct.id, warehouseId: warehouseAId },
    });
    expect(existing).toBeNull();

    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: newProduct.id, price: '500', quantity: '15' }],
    });
    const purchaseId = created.body.id as string;

    const res = await asA('patch', `/api/v1/purchases/${purchaseId}/validate`).send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const pw = await prisma.productWarehouse.findFirst({
      where: { productId: newProduct.id, warehouseId: warehouseAId },
    });
    expect(pw).not.toBeNull();
    expect(new Decimal(pw!.quantity).toString()).toBe('15');
    expect(pw!.version).toBe(1); // créé à 0, incrémenté une fois par adjustStock

    await prisma.productWarehouse.deleteMany({ where: { productId: newProduct.id } });
    await prisma.purchaseDetail.deleteMany({ where: { purchaseId } });
    await prisma.purchase.deleteMany({ where: { id: purchaseId } });
    await prisma.product.deleteMany({ where: { id: newProduct.id } });
    await prisma.category.deleteMany({ where: { id: catB.id } });
  });

  it('non-régression — update()/remove() sur un achat COMPLETED via validate() → toujours 400', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('50'), version: 0 },
    });

    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    const purchaseId = created.body.id as string;

    const validateRes = await asA('patch', `/api/v1/purchases/${purchaseId}/validate`).send();
    expect(validateRes.status).toBe(200);

    const updateRes = await asA('patch', `/api/v1/purchases/${purchaseId}`).send({ notes: 'x' });
    expect(updateRes.status).toBe(400);

    const deleteRes = await asA('delete', `/api/v1/purchases/${purchaseId}`);
    expect(deleteRes.status).toBe(400);
  });

  // ─── Test de concurrence "lost update" (livrable central de cet agent) ──────
  //
  // À la différence du test de concurrence S21 sur les ventes (un seul gagnant, 200/409,
  // parce qu'un décrément peut légitimement échouer sur stock insuffisant), un achat ne
  // porte AUCUNE garde de ce type : un incrément est toujours mécaniquement fusionnable.
  // L'utilisateur a donc validé (TÂCHE 1) l'ajout d'un retry automatique borné (5 tentatives
  // max) dans PurchaseService.validate(), qui n'existe PAS dans SaleService.validate(). Ce
  // test attend que les DEUX validations concurrentes réussissent (200/200) et que la
  // quantité finale soit la somme exacte des deux incréments — sans ce retry, l'une des deux
  // recevrait un 409 par intermittence (conflit de version optimiste ou P2034 Postgres sur
  // le même ProductWarehouse), comme documenté dans le rapport de session.
  it(
    'concurrence — deux achats simultanés sur le même ProductWarehouse : les deux réussissent (retry), ' +
      'quantité finale = somme exacte des deux incréments',
    async () => {
      await prisma.productWarehouse.update({
        where: { id: pwValId },
        data: { quantity: new Decimal('10'), version: 0 },
      });

      const purchase1 = await asA('post', '/api/v1/purchases').send({
        providerId: providerAId,
        warehouseId: warehouseAId,
        date: '2026-07-26T00:00:00.000Z',
        details: [{ productId: productAId, price: '1000', quantity: '5' }],
      });
      const purchase2 = await asA('post', '/api/v1/purchases').send({
        providerId: providerAId,
        warehouseId: warehouseAId,
        date: '2026-07-26T00:00:00.000Z',
        details: [{ productId: productAId, price: '1000', quantity: '7' }],
      });

      // Lancées réellement en parallèle contre une vraie base Postgres — c'est le retry
      // automatique de PurchaseService.validate() (TÂCHE 1) qui doit absorber le conflit
      // de version optimiste / de sérialisation Postgres sur le même ProductWarehouse,
      // pas un mock.
      const [res1, res2] = await Promise.all([
        asA('patch', `/api/v1/purchases/${purchase1.body.id as string}/validate`).send(),
        asA('patch', `/api/v1/purchases/${purchase2.body.id as string}/validate`).send(),
      ]);

      expect(res1.status).toBe(200); // LES DEUX réussissent — preuve du retry
      expect(res2.status).toBe(200);

      const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
      // 10 (initial) + 5 + 7 = 22, jamais l'une des deux perdue (lost update).
      expect(new Decimal(pw!.quantity).toString()).toBe('22');

      const [reload1, reload2] = await Promise.all([
        prisma.purchase.findUnique({ where: { id: purchase1.body.id as string } }),
        prisma.purchase.findUnique({ where: { id: purchase2.body.id as string } }),
      ]);
      expect(reload1!.status).toBe('COMPLETED');
      expect(reload2!.status).toBe('COMPLETED');
    },
  );
});

// ─── POST /purchases/:id/send (S32/S33) ────────────────────────────────────────
// Envoie le récapitulatif d'un achat au fournisseur par email ou SMS — enfile un job BullMQ
// fire-and-forget sur la file 'email'/'sms' (mode test, aucun appel réseau réel). Fournisseur
// dédié à ce describe (email + téléphone renseignés), distinct de providerAId (sans contact
// renseigné, réutilisé tel quel par les tests précédents) pour ne risquer aucune régression sur
// les describe blocks en amont.

describe('POST /api/v1/purchases/:id/send', () => {
  let providerContactId: string;

  beforeAll(async () => {
    const provider = await prisma.provider.create({
      data: {
        organizationId: orgAId,
        name: `Fournisseur Purchase Contact ${SUFFIX}`,
        code: 2,
        email: `provider-send-${SUFFIX}@e2e.cm`,
        phone: '+237600000001',
      },
    });
    providerContactId = provider.id;
  });

  async function createPurchase(providerId: string): Promise<string> {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    return created.body.id as string;
  }

  it('202 — channel email, fournisseur avec email renseigné → job enfilé', async () => {
    const purchaseId = await createPurchase(providerContactId);

    const res = await asA('post', `/api/v1/purchases/${purchaseId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it('202 — channel sms, fournisseur avec téléphone renseigné → job enfilé', async () => {
    const purchaseId = await createPurchase(providerContactId);

    const res = await asA('post', `/api/v1/purchases/${purchaseId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it("400 — channel email, fournisseur sans adresse email enregistrée", async () => {
    // providerAId (créé dans le beforeAll global) n'a ni email ni téléphone renseignés.
    const purchaseId = await createPurchase(providerAId);

    const res = await asA('post', `/api/v1/purchases/${purchaseId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Ce fournisseur n'a pas d'adresse email enregistrée.");
  });

  it('400 — channel sms, fournisseur sans numéro de téléphone enregistré', async () => {
    const purchaseId = await createPurchase(providerAId);

    const res = await asA('post', `/api/v1/purchases/${purchaseId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Ce fournisseur n'a pas de numéro de téléphone enregistré.");
  });

  it('422 — channel absent ou invalide', async () => {
    const purchaseId = await createPurchase(providerContactId);

    const resMissing = await asA('post', `/api/v1/purchases/${purchaseId}/send`).send({});
    expect(resMissing.status).toBe(422);

    const resInvalid = await asA('post', `/api/v1/purchases/${purchaseId}/send`).send({ channel: 'fax' });
    expect(resInvalid.status).toBe(422);
  });

  it('404 — achat inexistant', async () => {
    const res = await asA('post', '/api/v1/purchases/00000000-0000-0000-0000-000000000000/send').send({
      channel: 'email',
    });

    expect(res.status).toBe(404);
  });

  it('403 — isolation tenant : org B ne peut pas envoyer un achat de org A', async () => {
    const purchaseId = await createPurchase(providerContactId);

    const res = await asB('post', `/api/v1/purchases/${purchaseId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/purchases/:id/pdf', () => {
  async function createPurchase(): Promise<string> {
    const created = await asA('post', '/api/v1/purchases').send({
      providerId: providerAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    return created.body.id as string;
  }

  it('202 — enfile le job de génération PDF', async () => {
    const purchaseId = await createPurchase();

    const res = await asA('post', `/api/v1/purchases/${purchaseId}/pdf`).send();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it('404 — achat inexistant', async () => {
    const res = await asA('post', '/api/v1/purchases/00000000-0000-0000-0000-000000000000/pdf').send();

    expect(res.status).toBe(404);
  });

  it('403 — isolation tenant : org B ne peut pas générer le PDF d\'un achat de org A', async () => {
    const purchaseId = await createPurchase();

    const res = await asB('post', `/api/v1/purchases/${purchaseId}/pdf`).send();

    expect(res.status).toBe(403);
  });
});

// ─── POST /purchases/payments/:id/send (S32/S33) ───────────────────────────────
// Envoie le reçu d'un paiement d'achat au fournisseur par email ou SMS — mirror exact du
// describe précédent, sur le paiement plutôt que sur l'achat.

describe('POST /api/v1/purchases/payments/:id/send', () => {
  let providerContactId: string;

  beforeAll(async () => {
    const provider = await prisma.provider.create({
      data: {
        organizationId: orgAId,
        name: `Fournisseur Payment Contact ${SUFFIX}`,
        code: 3,
        email: `provider-payment-send-${SUFFIX}@e2e.cm`,
        phone: '+237600000002',
      },
    });
    providerContactId = provider.id;
  });

  async function createPurchaseWithPayment(providerId: string): Promise<string> {
    const purchase = await asA('post', '/api/v1/purchases').send({
      providerId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    const purchaseId = purchase.body.id as string;

    const payment = await asA('post', `/api/v1/purchases/${purchaseId}/payments`).send({
      date: '2026-07-26T00:00:00.000Z',
      amount: '500',
      method: 'CASH',
    });
    return payment.body.id as string;
  }

  it('202 — channel email, fournisseur avec email renseigné → job enfilé', async () => {
    const paymentId = await createPurchaseWithPayment(providerContactId);

    const res = await asA('post', `/api/v1/purchases/payments/${paymentId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it('202 — channel sms, fournisseur avec téléphone renseigné → job enfilé', async () => {
    const paymentId = await createPurchaseWithPayment(providerContactId);

    const res = await asA('post', `/api/v1/purchases/payments/${paymentId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it("400 — channel email, fournisseur sans adresse email enregistrée", async () => {
    const paymentId = await createPurchaseWithPayment(providerAId);

    const res = await asA('post', `/api/v1/purchases/payments/${paymentId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Ce fournisseur n'a pas d'adresse email enregistrée.");
  });

  it('400 — channel sms, fournisseur sans numéro de téléphone enregistré', async () => {
    const paymentId = await createPurchaseWithPayment(providerAId);

    const res = await asA('post', `/api/v1/purchases/payments/${paymentId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Ce fournisseur n'a pas de numéro de téléphone enregistré.");
  });

  it('422 — channel absent ou invalide', async () => {
    const paymentId = await createPurchaseWithPayment(providerContactId);

    const resMissing = await asA('post', `/api/v1/purchases/payments/${paymentId}/send`).send({});
    expect(resMissing.status).toBe(422);

    const resInvalid = await asA('post', `/api/v1/purchases/payments/${paymentId}/send`).send({
      channel: 'fax',
    });
    expect(resInvalid.status).toBe(422);
  });

  it('404 — paiement inexistant', async () => {
    const res = await asA(
      'post',
      '/api/v1/purchases/payments/00000000-0000-0000-0000-000000000000/send',
    ).send({ channel: 'email' });

    expect(res.status).toBe(404);
  });

  it('403 — isolation tenant : org B ne peut pas envoyer un paiement de org A', async () => {
    const paymentId = await createPurchaseWithPayment(providerContactId);

    const res = await asB('post', `/api/v1/purchases/payments/${paymentId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(403);
  });
});
