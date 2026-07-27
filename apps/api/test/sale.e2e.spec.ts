/**
 * Tests d'intégration Sale (S19).
 *
 * Couvre :
 *  - Création d'une vente PENDING (POST → 201), référence VTE-…, grandTotal en base
 *  - GET /sales paginé, isolation multi-tenant
 *  - GET /sales/:id avec détails
 *  - PATCH /sales/:id — lignes recalculées, uniquement si PENDING
 *  - DELETE /sales/:id — 204 si PENDING ; 400 si COMPLETED
 *  - records.viewAll : sans la permission, un utilisateur ne voit que ses propres ventes
 *  - PATCH /sales/:id/validate (S21) — décrémente ProductWarehouse.quantity, PENDING → COMPLETED,
 *    stock insuffisant, isolation tenant, non-régression update()/remove() post-validation, et
 *    surtout le test de concurrence critère « Fait quand » du plan : deux validations simultanées
 *    sur le dernier exemplaire d'un produit → une seule réussit, stock jamais négatif.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
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

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-sale-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-sale-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;        // Admin org A — a records.viewAll
let tokenA2: string;       // Utilisateur org A sans records.viewAll
let tokenB: string;
let clientAId: string;
let warehouseAId: string;
let productAId: string;
let pwValId: string; // ProductWarehouse dédié aux tests de validate() (productAId @ warehouseAId)

const PERMS = ['sales.view', 'sales.create', 'sales.edit', 'sales.delete', 'sales.validate', 'records.viewAll'];
const PERMS_NO_VIEWALL = ['sales.view', 'sales.create', 'sales.edit', 'sales.delete'];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E Sale Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Sale Org B', subdomain: ORG_B_SUBDOMAIN } });
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
        lastname: 'Sale',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  await setupUser(orgAId, `sale-a-${SUFFIX}@e2e.cm`, 'Admin', permsFull);
  await setupUser(orgAId, `sale-a2-${SUFFIX}@e2e.cm`, 'Vendeur', permsNoViewAll);
  await setupUser(orgBId, `sale-b-${SUFFIX}@e2e.cm`, 'Admin', permsFull);

  // Données de base pour org A
  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-SALE-${SUFFIX}`, name: 'Cat Sale A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-SALE-${SUFFIX}`,
      name: 'Produit Vente A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH Sale-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  const clientA = await prisma.client.create({
    data: { organizationId: orgAId, name: `Client Sale ${SUFFIX}`, code: 1 },
  });
  clientAId = clientA.id;

  // Stock initial pour les tests validate() (S21) — remis à l'état voulu au début de chaque test.
  const pwVal = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('100'), version: 0 },
  });
  pwValId = pwVal.id;

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

  tokenA  = await login(orgAId, `sale-a-${SUFFIX}@e2e.cm`);
  tokenA2 = await login(orgAId, `sale-a2-${SUFFIX}@e2e.cm`);
  tokenB  = await login(orgBId, `sale-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  // Nettoyage dans l'ordre des FK
  await prisma.saleDetail.deleteMany({ where: { sale: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.sale.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
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

// ─── POST /sales ────────────────────────────────────────────────────────────

describe('POST /api/v1/sales', () => {
  it('201 — crée une vente PENDING avec référence VTE-… et grandTotal correct', async () => {
    const res = await asA('post', '/api/v1/sales').send({
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
    expect(res.body.paymentStatus).toBe('UNPAID');
    expect(res.body.reference).toMatch(/^VTE-\d{4}-\d+$/);
    // sumLines = 2000, taxGlobal = 200, discount = 100, shipping = 50 → 2150
    expect(res.body.grandTotal).toBe('2150');

    const inDb = await prisma.sale.findUnique({ where: { id: res.body.id } });
    expect(inDb!.grandTotal.toString()).toBe('2150');
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/sales')
      .set('X-Organization-Id', orgAId)
      .send({});
    expect(res.status).toBe(401);
  });

  it('422 — payload invalide (details vide)', async () => {
    const res = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [],
    });
    expect(res.status).toBe(422);
  });

  it('isolation — tenant B ne peut pas créer une vente avec un client/entrepôt de tenant A', async () => {
    const res = await asB('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── GET /sales — pagination, isolation, records.viewAll ─────────────────────

describe('GET /api/v1/sales', () => {
  it('200 — paginé, tenant B ne voit pas les ventes de tenant A', async () => {
    await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    const res = await asB('get', '/api/v1/sales');

    expect(res.status).toBe(200);
    const data = res.body.data as { organizationId: string }[];
    expect(data.every((s) => s.organizationId !== orgAId)).toBe(true);
  });

  it("records.viewAll=false — l'utilisateur ne voit que ses propres ventes", async () => {
    // Vente créée par userA (tokenA)
    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '500', quantity: '1' }],
    });
    expect(created.status).toBe(201);

    // userA2 n'a pas records.viewAll → ne doit pas voir la vente créée par userA
    const res = await asA2('get', '/api/v1/sales');

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((s) => s.id);
    expect(ids).not.toContain(created.body.id);

    // userA (records.viewAll) doit la voir
    const resAdmin = await asA('get', '/api/v1/sales');
    const idsAdmin = (resAdmin.body.data as { id: string }[]).map((s) => s.id);
    expect(idsAdmin).toContain(created.body.id);
  });
});

// ─── GET /sales/:id ───────────────────────────────────────────────────────────

describe('GET /api/v1/sales/:id', () => {
  it('200 — retourne la vente avec ses lignes', async () => {
    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '3' }],
    });

    const res = await asA('get', `/api/v1/sales/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].quantity).toBe('3');
  });
});

// ─── PATCH /sales/:id ─────────────────────────────────────────────────────────

describe('PATCH /api/v1/sales/:id', () => {
  it('200 — recalcule les totaux après remplacement des lignes (PENDING)', async () => {
    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    const res = await asA('patch', `/api/v1/sales/${created.body.id}`)
      .send({ details: [{ productId: productAId, price: '1000', quantity: '5' }] });

    expect(res.status).toBe(200);
    expect(res.body.grandTotal).toBe('5000');
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].quantity).toBe('5');
  });

  it('400 — une vente COMPLETED ne peut pas être modifiée', async () => {
    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    await prisma.sale.update({ where: { id: created.body.id as string }, data: { status: 'COMPLETED' } });

    const res = await asA('patch', `/api/v1/sales/${created.body.id}`).send({ notes: 'x' });

    expect(res.status).toBe(400);
  });
});

// ─── PATCH /sales/:id/validate (S21) ──────────────────────────────────────────
// Mouvemente le stock (ProductWarehouse.quantity, verrouillage optimiste, transaction
// Serializable) puis fait passer le statut PENDING → COMPLETED. Chaque test remet le
// stock partagé (pwValId) à l'état voulu avant de créer sa propre vente, à l'identique
// du patron transfer.e2e.spec.ts.

describe('PATCH /api/v1/sales/:id/validate', () => {
  it('200 — décrémente ProductWarehouse.quantity et passe status à COMPLETED', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('100'), version: 0 },
    });

    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '4' }],
    });
    const saleId = created.body.id as string;

    const res = await asA('patch', `/api/v1/sales/${saleId}/validate`).send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('96');

    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale!.status).toBe('COMPLETED');
  });

  it('400 — stock insuffisant : quantité en base et statut PENDING inchangés', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('2'), version: 0 },
    });

    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '5' }],
    });
    const saleId = created.body.id as string;

    const res = await asA('patch', `/api/v1/sales/${saleId}/validate`).send();

    expect(res.status).toBe(400);

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('2');

    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale!.status).toBe('PENDING');
  });

  it(
    'concurrence — deux ventes simultanées sur le dernier exemplaire : exactement une 200 ' +
      'et une 409, stock final = 0 (jamais négatif, jamais 1)',
    async () => {
      await prisma.productWarehouse.update({
        where: { id: pwValId },
        data: { quantity: new Decimal('1'), version: 0 },
      });

      const sale1 = await asA('post', '/api/v1/sales').send({
        clientId: clientAId,
        warehouseId: warehouseAId,
        date: '2026-07-26T00:00:00.000Z',
        details: [{ productId: productAId, price: '1000', quantity: '1' }],
      });
      const sale2 = await asA('post', '/api/v1/sales').send({
        clientId: clientAId,
        warehouseId: warehouseAId,
        date: '2026-07-26T00:00:00.000Z',
        details: [{ productId: productAId, price: '1000', quantity: '1' }],
      });

      // Lancées réellement en parallèle contre une vraie base Postgres — c'est la
      // sérialisation Postgres (isolationLevel Serializable + verrouillage optimiste
      // adjustStock) qui doit arbitrer, pas un mock.
      const [res1, res2] = await Promise.all([
        asA('patch', `/api/v1/sales/${sale1.body.id as string}/validate`).send(),
        asA('patch', `/api/v1/sales/${sale2.body.id as string}/validate`).send(),
      ]);

      const statuses = [res1.status, res2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
      expect(new Decimal(pw!.quantity).toString()).toBe('0');

      // La vente gagnante est COMPLETED, la perdante reste PENDING (aucun double mouvement).
      const [reload1, reload2] = await Promise.all([
        prisma.sale.findUnique({ where: { id: sale1.body.id as string } }),
        prisma.sale.findUnique({ where: { id: sale2.body.id as string } }),
      ]);
      const finalStatuses = [reload1!.status, reload2!.status].sort();
      expect(finalStatuses).toEqual(['COMPLETED', 'PENDING']);
    },
  );

  it('403 — isolation tenant : org B ne peut pas valider une vente de org A', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('50'), version: 0 },
    });

    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    const saleId = created.body.id as string;

    const res = await asB('patch', `/api/v1/sales/${saleId}/validate`).send();

    expect(res.status).toBe(403);

    // Le stock et le statut de org A restent inchangés — l'échec de org B n'a aucun effet.
    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('50');
    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale!.status).toBe('PENDING');
  });

  it('non-régression — update()/remove() sur une vente COMPLETED via validate() → toujours 400', async () => {
    await prisma.productWarehouse.update({
      where: { id: pwValId },
      data: { quantity: new Decimal('50'), version: 0 },
    });

    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });
    const saleId = created.body.id as string;

    const validateRes = await asA('patch', `/api/v1/sales/${saleId}/validate`).send();
    expect(validateRes.status).toBe(200);

    const updateRes = await asA('patch', `/api/v1/sales/${saleId}`).send({ notes: 'x' });
    expect(updateRes.status).toBe(400);

    const deleteRes = await asA('delete', `/api/v1/sales/${saleId}`);
    expect(deleteRes.status).toBe(400);
  });
});

// ─── DELETE /sales/:id ────────────────────────────────────────────────────────

describe('DELETE /api/v1/sales/:id', () => {
  it('204 — supprime une vente PENDING', async () => {
    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    const res = await asA('delete', `/api/v1/sales/${created.body.id}`);

    expect(res.status).toBe(204);
  });

  it('400 — une vente COMPLETED ne peut pas être supprimée', async () => {
    const created = await asA('post', '/api/v1/sales').send({
      clientId: clientAId,
      warehouseId: warehouseAId,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: productAId, price: '1000', quantity: '1' }],
    });

    await prisma.sale.update({ where: { id: created.body.id as string }, data: { status: 'COMPLETED' } });

    const res = await asA('delete', `/api/v1/sales/${created.body.id}`);

    expect(res.status).toBe(400);
  });
});
