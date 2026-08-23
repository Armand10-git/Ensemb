/**
 * Tests d'intégration SaleReturn (S26 — Bloc F/E, §18.6, mirror du patron sale.e2e.spec.ts /
 * purchase.e2e.spec.ts).
 *
 * Couvre :
 *  - POST /sale-returns : 201, référence RVT-…, grandTotal calculé, IDOR (saleId d'une autre
 *    org, saleDetailId d'un AUTRE Sale que celui déclaré), source non-COMPLETED, quantité
 *    dépassant la quantité vendue (cas simple ET cas cumulé via deux validations successives)
 *  - PATCH /sale-returns/:id/validate : incrémente ProductWarehouse.quantity, PENDING →
 *    COMPLETED, refuse un retour déjà COMPLETED, isolation tenant
 *  - LE TEST DE CONCURRENCE (critère « Fait quand » de cette session) : deux SaleReturn PENDING
 *    distincts sur la MÊME SaleDetail source, dont la somme dépasse la quantité vendue,
 *    validés en vrai parallèle contre une vraie base Postgres — write skew Serializable.
 *  - GET /sale-returns paginé, isolation tenant, records.viewAll
 *  - DELETE /sale-returns/:id — 204 si PENDING, 400 si COMPLETED
 *
 * Seul ReturnsModule est importé (avec les modules d'infra communs) — SalesModule n'est PAS
 * nécessaire : la vente d'origine et ses lignes sont créées directement via prisma.sale.create/
 * prisma.saleDetail.create (statut COMPLETED), comme demandé par le prompt de session.
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
import { ReturnsModule } from '../src/modules/returns/returns.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-sret-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-sret-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;   // Admin org A — a records.viewAll
let tokenA2: string;  // Utilisateur org A sans records.viewAll
let tokenB: string;
let adminAId: string;
let clientAId: string;
let warehouseAId: string;
let productAId: string;
let pwValId: string; // ProductWarehouse dédié aux tests de validate() (productAId @ warehouseAId)

const PERMS = ['saleReturns.view', 'saleReturns.create', 'saleReturns.edit', 'saleReturns.delete', 'saleReturns.validate', 'records.viewAll'];
const PERMS_NO_VIEWALL = ['saleReturns.view', 'saleReturns.create', 'saleReturns.edit', 'saleReturns.delete'];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E SaleReturn Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E SaleReturn Org B', subdomain: ORG_B_SUBDOMAIN } });
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
        lastname: 'SaleReturn',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  adminAId = await setupUser(orgAId, `sret-a-${SUFFIX}@e2e.cm`, 'Admin', permsFull);
  await setupUser(orgAId, `sret-a2-${SUFFIX}@e2e.cm`, 'Vendeur', permsNoViewAll);
  await setupUser(orgBId, `sret-b-${SUFFIX}@e2e.cm`, 'Admin', permsFull);

  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-SRET-${SUFFIX}`, name: 'Cat SaleReturn A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-SRET-${SUFFIX}`,
      name: 'Produit Retour Vente A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH SaleReturn-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  const clientA = await prisma.client.create({
    data: { organizationId: orgAId, name: `Client SaleReturn ${SUFFIX}`, code: 1 },
  });
  clientAId = clientA.id;

  // Stock initial — simule l'état APRÈS la vente d'origine (déjà décrémenté). Remis à l'état
  // voulu au début de chaque test de validate() (patron identique à sale.e2e.spec.ts).
  const pwVal = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('0'), version: 0 },
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

  tokenA  = await login(orgAId, `sret-a-${SUFFIX}@e2e.cm`);
  tokenA2 = await login(orgAId, `sret-a2-${SUFFIX}@e2e.cm`);
  tokenB  = await login(orgBId, `sret-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  // Nettoyage dans l'ordre des FK
  await prisma.paymentReturn.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.saleReturnDetail.deleteMany({ where: { saleReturn: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.saleReturn.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
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

/**
 * Crée directement en base (hors HTTP, hors SalesModule) une vente COMPLETED avec une seule
 * ligne connue — simule une vente déjà finalisée sur laquelle porter un retour. Chaque appel
 * utilise une référence unique (contrainte @@unique([organizationId, reference])).
 */
async function createCompletedSaleWithDetail(
  orgId: string,
  userId: string,
  quantity: string,
  price = '1000',
): Promise<{ saleId: string; saleDetailId: string }> {
  const total = new Decimal(price).times(quantity);
  const sale = await prisma.sale.create({
    data: {
      organizationId: orgId,
      reference: `TST-SALE-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: new Date('2026-07-26'),
      userId,
      clientId: clientAId,
      warehouseId: warehouseAId,
      taxRate: new Decimal('0'),
      taxAmount: new Decimal('0'),
      discount: new Decimal('0'),
      shipping: new Decimal('0'),
      grandTotal: total,
      paidAmount: new Decimal('0'),
      paymentStatus: 'UNPAID',
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
  return { saleId: sale.id, saleDetailId: detail.id };
}

async function createCompletedSaleWithStatus(
  orgId: string,
  userId: string,
  status: 'PENDING' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'CANCELLED',
  quantity: string,
): Promise<{ saleId: string; saleDetailId: string }> {
  const price = '1000';
  const total = new Decimal(price).times(quantity);
  const sale = await prisma.sale.create({
    data: {
      organizationId: orgId,
      reference: `TST-SALE-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: new Date('2026-07-26'),
      userId,
      clientId: clientAId,
      warehouseId: warehouseAId,
      taxRate: new Decimal('0'),
      taxAmount: new Decimal('0'),
      discount: new Decimal('0'),
      shipping: new Decimal('0'),
      grandTotal: total,
      paidAmount: new Decimal('0'),
      paymentStatus: 'UNPAID',
      status,
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
  return { saleId: sale.id, saleDetailId: detail.id };
}

// ─── POST /sale-returns ─────────────────────────────────────────────────────

describe('POST /api/v1/sale-returns', () => {
  it('201 — crée un retour PENDING avec référence RVT-… et grandTotal = somme des lignes', async () => {
    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10', '1000');

    const res = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '4' }],
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.reference).toMatch(/^RVT-\d{4}-\d+$/);
    expect(res.body.grandTotal).toBe('4000');

    const inDb = await prisma.saleReturn.findUnique({ where: { id: res.body.id } });
    expect(inDb!.grandTotal.toString()).toBe('4000');
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/sale-returns')
      .set('X-Organization-Id', orgAId)
      .send({});
    expect(res.status).toBe(401);
  });

  it('422 — payload invalide (details vide)', async () => {
    const { saleId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10');
    const res = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [],
    });
    expect(res.status).toBe(422);
  });

  it('IDOR — tenant B ne peut pas créer un retour sur une vente de tenant A', async () => {
    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10');

    const res = await asB('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '1' }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("IDOR croisé — saleId du PREMIER document mais saleDetailId d'une ligne du DEUXIÈME → rejeté", async () => {
    const first = await createCompletedSaleWithDetail(orgAId, adminAId, '10');
    const second = await createCompletedSaleWithDetail(orgAId, adminAId, '5');

    const res = await asA('post', '/api/v1/sale-returns').send({
      saleId: first.saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId: second.saleDetailId, quantity: '1' }],
    });

    expect(res.status).toBe(403);

    const created = await prisma.saleReturn.findFirst({ where: { saleId: first.saleId } });
    expect(created).toBeNull();
  });

  it('400 — retour sur une vente PENDING (pas COMPLETED)', async () => {
    const { saleId, saleDetailId } = await createCompletedSaleWithStatus(orgAId, adminAId, 'PENDING', '10');

    const res = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '1' }],
    });
    expect(res.status).toBe(400);
  });

  it('400 — retour sur une vente CANCELLED', async () => {
    const { saleId, saleDetailId } = await createCompletedSaleWithStatus(orgAId, adminAId, 'CANCELLED', '10');

    const res = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '1' }],
    });
    expect(res.status).toBe(400);
  });

  it('400 — quantité retournée dépasse la quantité vendue (cas simple, une seule ligne)', async () => {
    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '5');

    const res = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '6' }],
    });
    expect(res.status).toBe(400);
  });

  it(
    '400 — cas CUMULÉ : deux retours successifs COMPLETED (pas concurrents) sur la même ligne, ' +
      'le deuxième dépasse le total restant',
    async () => {
      const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10');

      const first = await asA('post', '/api/v1/sale-returns').send({
        saleId,
        date: '2026-07-27T00:00:00.000Z',
        details: [{ saleDetailId, quantity: '6' }],
      });
      expect(first.status).toBe(201);
      const firstValidate = await asA('patch', `/api/v1/sale-returns/${first.body.id as string}/validate`).send();
      expect(firstValidate.status).toBe(200);

      // create() est best-effort par ligne (ignore les autres retours) → 6 ≤ 10 passe à la création.
      const second = await asA('post', '/api/v1/sale-returns').send({
        saleId,
        date: '2026-07-27T00:00:00.000Z',
        details: [{ saleDetailId, quantity: '6' }],
      });
      expect(second.status).toBe(201);

      // La garde AUTORITATIVE cumulée est dans validate() : 6 (déjà retourné) + 6 (cette ligne) = 12 > 10.
      const secondValidate = await asA('patch', `/api/v1/sale-returns/${second.body.id as string}/validate`).send();
      expect(secondValidate.status).toBe(400);

      const secondReload = await prisma.saleReturn.findUnique({ where: { id: second.body.id as string } });
      expect(secondReload!.status).toBe('PENDING');
    },
  );

  it(
    '400 — fractionnement SÉQUENTIEL (pas concurrent) : 5 retours PENDING de 3 unités créés sur ' +
      'une ligne source de 10 vendues, validés un par un dans l\'ordre — les 3 premiers doivent ' +
      "réussir (cumul 9/10), le 4e doit échouer (9+3=12>10) SANS être tronqué silencieusement à 1, " +
      'et le stock ne doit refléter que les 3 validations réellement COMPLETED (+9, pas +12)',
    async () => {
      const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10');

      // Crée les 5 retours PENDING AVANT toute validation — create() est best-effort par ligne
      // (3 ≤ 10 passe systématiquement à la création, qui ignore les autres retours existants).
      const returnIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await asA('post', '/api/v1/sale-returns').send({
          saleId,
          date: '2026-07-27T00:00:00.000Z',
          details: [{ saleDetailId, quantity: '3' }],
        });
        expect(res.status).toBe(201);
        returnIds.push(res.body.id as string);
      }

      // Capture le stock juste AVANT les validations (pas une constante figée : productAId/
      // warehouseAId sont partagés avec d'autres tests de ce fichier qui incrémentent déjà le
      // stock via validate() — seul le delta introduit par CE test doit être vérifié).
      const pwBeforeValidations = await prisma.productWarehouse.findFirst({
        where: { productId: productAId, warehouseId: warehouseAId },
      });
      const pwValBaseline = pwBeforeValidations!.quantity;

      // Valide séquentiellement (attend chaque réponse avant de lancer la suivante — pas de
      // Promise.all ici, contrairement au test de write skew ci-dessous) : la garde cumulée doit
      // relire l'état réel en base à CHAQUE appel, pas un état capturé une seule fois.
      const statuses: number[] = [];
      for (const id of returnIds) {
        const res = await asA('patch', `/api/v1/sale-returns/${id}/validate`).send();
        statuses.push(res.status);
      }

      // 3×3=9 ≤ 10 : les trois premiers passent. 9+3=12 > 10 : le 4e échoue. Le 5e échoue aussi
      // (9 déjà retourné, toujours > 10 - 3 = 7 restant).
      expect(statuses).toEqual([200, 200, 200, 400, 400]);

      const reloaded = await prisma.saleReturn.findMany({
        where: { id: { in: returnIds } },
        select: { id: true, status: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(reloaded.map((r) => r.status)).toEqual([
        'COMPLETED',
        'COMPLETED',
        'COMPLETED',
        'PENDING',
        'PENDING',
      ]);

      // Le 4e retour PENDING n'a PAS été tronqué à la quantité restante (1) : sa ligne conserve
      // exactement sa quantité déclarée (3), inchangée — l'échec est total, pas une troncature
      // silencieuse.
      const fourthDetail = await prisma.saleReturnDetail.findFirst({
        where: { saleReturnId: returnIds[3] },
      });
      expect(fourthDetail!.quantity.toString()).toBe('3');

      // Le stock ne reflète que +9 (3 validations COMPLETED), jamais +12.
      const pw = await prisma.productWarehouse.findFirst({
        where: { productId: productAId, warehouseId: warehouseAId },
      });
      expect(pw!.quantity.toString()).toBe(new Decimal(pwValBaseline).plus('9').toString());
    },
  );
});

// ─── GET /sale-returns — pagination, isolation, records.viewAll ──────────────

describe('GET /api/v1/sale-returns', () => {
  it('200 — paginé, tenant B ne voit pas les retours de tenant A', async () => {
    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '5');
    await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '1' }],
    });

    const res = await asB('get', '/api/v1/sale-returns');

    expect(res.status).toBe(200);
    const data = res.body.data as { organizationId: string }[];
    expect(data.every((r) => r.organizationId !== orgAId)).toBe(true);
  });

  it("records.viewAll=false — l'utilisateur ne voit que ses propres retours", async () => {
    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '5');
    const created = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '1' }],
    });
    expect(created.status).toBe(201);

    const res = await asA2('get', '/api/v1/sale-returns');
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(created.body.id);

    const resAdmin = await asA('get', '/api/v1/sale-returns');
    const idsAdmin = (resAdmin.body.data as { id: string }[]).map((r) => r.id);
    expect(idsAdmin).toContain(created.body.id);
  });
});

// ─── PATCH /sale-returns/:id/validate ────────────────────────────────────────

describe('PATCH /api/v1/sale-returns/:id/validate', () => {
  it('200 — incrémente ProductWarehouse.quantity et passe status à COMPLETED', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('50'), version: 0 } });

    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10');
    const created = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '4' }],
    });
    const returnId = created.body.id as string;

    const res = await asA('patch', `/api/v1/sale-returns/${returnId}/validate`).send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('54');

    const saleReturn = await prisma.saleReturn.findUnique({ where: { id: returnId } });
    expect(saleReturn!.status).toBe('COMPLETED');
  });

  it('400 — refuse un retour déjà COMPLETED (pas de revalidation, pas de double incrément)', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('20'), version: 0 } });

    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10');
    const created = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '3' }],
    });
    const returnId = created.body.id as string;

    const first = await asA('patch', `/api/v1/sale-returns/${returnId}/validate`).send();
    expect(first.status).toBe(200);

    const second = await asA('patch', `/api/v1/sale-returns/${returnId}/validate`).send();
    expect(second.status).toBe(400);

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('23'); // 20 + 3, jamais 26
  });

  it('403 — isolation tenant : org B ne peut pas valider un retour de org A', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('20'), version: 0 } });

    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10');
    const created = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '2' }],
    });
    const returnId = created.body.id as string;

    const res = await asB('patch', `/api/v1/sale-returns/${returnId}/validate`).send();
    expect(res.status).toBe(403);

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('20');
    const saleReturn = await prisma.saleReturn.findUnique({ where: { id: returnId } });
    expect(saleReturn!.status).toBe('PENDING');
  });

  // ─── Test de concurrence — write skew Serializable (cœur de cette session) ─────
  //
  // Deux SaleReturn PENDING distincts, chacun avec une ligne de 6 sur la MÊME SaleDetail
  // source (quantity=10 vendue), 6+6=12 > 10. Validés en vrai parallèle contre Postgres.
  //
  // Mécanisme attendu (cf. JSDoc de SaleReturnService.validate()) :
  //  1. Les deux transactions Serializable lisent au départ 0 retour COMPLETED existant sur
  //     cette ligne → chacune calcule isolément 0+6=6 ≤ 10, passe son propre contrôle.
  //  2. Les deux tentent d'incrémenter le MÊME ProductWarehouse → Postgres SSI détecte le
  //     conflit de sérialisation (write skew) et abort l'une des deux (P2034).
  //  3. SaleReturnService.validate() RETENTE automatiquement (MAX_VALIDATE_ATTEMPTS=5) : à la
  //     2e tentative, la transaction perdante relit l'état — l'autre retour est désormais
  //     COMPLETED (6 déjà retourné) + sa propre ligne (6) = 12 > 10 → BadRequestException,
  //     PAS une erreur de concurrence, donc remontée immédiatement (pas re-retentée).
  //  Résultat déterministe attendu : statuts triés [200, 400].
  //
  // L'invariant vérifié en base est le vrai critère de correction (plus important que le code
  // HTTP exact) : exactement un retour COMPLETED, l'autre PENDING ; le ProductWarehouse n'a
  // bougé que d'UNE fois (delta = 6, pas 12) ; la somme cumulée des retours COMPLETED sur
  // cette ligne ne dépasse jamais 10.
  it(
    'concurrence — deux retours PENDING sur la même SaleDetail (6+6=12 > 10 vendues), validés en ' +
      'parallèle : exactement un COMPLETED, stock incrémenté une seule fois (delta = 6, jamais 12)',
    async () => {
      await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('0'), version: 0 } });

      const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '10');

      const ret1 = await asA('post', '/api/v1/sale-returns').send({
        saleId,
        date: '2026-07-27T00:00:00.000Z',
        details: [{ saleDetailId, quantity: '6' }],
      });
      const ret2 = await asA('post', '/api/v1/sale-returns').send({
        saleId,
        date: '2026-07-27T00:00:00.000Z',
        details: [{ saleDetailId, quantity: '6' }],
      });
      expect(ret1.status).toBe(201);
      expect(ret2.status).toBe(201);

      // Lancées réellement en parallèle contre une vraie base Postgres — c'est la
      // sérialisation Postgres (Serializable + retry borné de SaleReturnService.validate())
      // qui doit arbitrer, jamais un mock.
      const [res1, res2] = await Promise.all([
        asA('patch', `/api/v1/sale-returns/${ret1.body.id as string}/validate`).send(),
        asA('patch', `/api/v1/sale-returns/${ret2.body.id as string}/validate`).send(),
      ]);

      const statuses = [res1.status, res2.status].sort((a, b) => a - b);
      // Observé empiriquement sur 9 exécutions consécutives (5 en isolation + 4 dans la suite
      // complète) : toujours [200, 400], exactement le mécanisme documenté dans le JSDoc de
      // SaleReturnService.validate() (retry qui relit l'état et découvre le dépassement
      // métier). On garde malgré tout un filet légèrement plus robuste que l'égalité stricte
      // (jamais [200, 200], et le premier tri est toujours 200) au cas où un futur run isolé
      // emprunterait un chemin de conflit différent (ex. ConflictException après épuisement de
      // MAX_VALIDATE_ATTEMPTS) — l'invariant en base ci-dessous reste la vérité absolue.
      expect(statuses).not.toEqual([200, 200]);
      expect(statuses[0]).toBe(200);
      expect([400, 409]).toContain(statuses[1]);

      const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
      // Un seul incrément de 6 a été appliqué — jamais 12 (double mouvement), jamais 0 (aucun).
      expect(new Decimal(pw!.quantity).toString()).toBe('6');

      const [reload1, reload2] = await Promise.all([
        prisma.saleReturn.findUnique({ where: { id: ret1.body.id as string } }),
        prisma.saleReturn.findUnique({ where: { id: ret2.body.id as string } }),
      ]);
      const finalStatuses = [reload1!.status, reload2!.status].sort();
      expect(finalStatuses).toEqual(['COMPLETED', 'PENDING']);

      // Invariant final : la somme cumulée des retours COMPLETED sur cette ligne ne dépasse
      // jamais la quantité vendue à l'origine (10).
      const completedDetails = await prisma.saleReturnDetail.findMany({
        where: { saleDetailId, saleReturn: { status: 'COMPLETED' } },
      });
      const totalReturned = completedDetails.reduce((acc, d) => acc.plus(new Decimal(d.quantity)), new Decimal(0));
      expect(totalReturned.lessThanOrEqualTo(new Decimal('10'))).toBe(true);
      expect(totalReturned.toString()).toBe('6');
    },
  );
});

// ─── DELETE /sale-returns/:id ─────────────────────────────────────────────────

describe('DELETE /api/v1/sale-returns/:id', () => {
  it('204 — supprime un retour PENDING', async () => {
    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '5');
    const created = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '1' }],
    });

    const res = await asA('delete', `/api/v1/sale-returns/${created.body.id as string}`);
    expect(res.status).toBe(204);
  });

  it('400 — un retour COMPLETED ne peut pas être supprimé', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('20'), version: 0 } });
    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '5');
    const created = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '1' }],
    });
    const returnId = created.body.id as string;
    const validated = await asA('patch', `/api/v1/sale-returns/${returnId}/validate`).send();
    expect(validated.status).toBe(200);

    const res = await asA('delete', `/api/v1/sale-returns/${returnId}`);
    expect(res.status).toBe(400);
  });
});

// ─── POST /sale-returns/:id/send (S32/S33) ─────────────────────────────────────
// Envoie le récapitulatif d'un retour de vente au client par email ou SMS — enfile un job
// BullMQ fire-and-forget sur la file 'email'/'sms' (mode test, aucun appel réseau réel). Client
// dédié à ce describe (email + téléphone renseignés) affecté à la vente d'origine après
// création — clientAId (utilisé par createCompletedSaleWithDetail) n'a ni email ni téléphone
// renseignés, réutilisé tel quel pour les tests 400.

describe('POST /api/v1/sale-returns/:id/send', () => {
  let clientContactId: string;

  beforeAll(async () => {
    const client = await prisma.client.create({
      data: {
        organizationId: orgAId,
        name: `Client SaleReturn Contact ${SUFFIX}`,
        code: 2,
        email: `client-return-send-${SUFFIX}@e2e.cm`,
        phone: '+237600000004',
      },
    });
    clientContactId = client.id;
  });

  async function createSaleReturn(clientId: string): Promise<string> {
    const { saleId, saleDetailId } = await createCompletedSaleWithDetail(orgAId, adminAId, '2');
    await prisma.sale.update({ where: { id: saleId }, data: { clientId } });

    const created = await asA('post', '/api/v1/sale-returns').send({
      saleId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ saleDetailId, quantity: '1' }],
    });
    return created.body.id as string;
  }

  it('202 — channel email, client avec email renseigné → job enfilé', async () => {
    const returnId = await createSaleReturn(clientContactId);

    const res = await asA('post', `/api/v1/sale-returns/${returnId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it('202 — channel sms, client avec téléphone renseigné → job enfilé', async () => {
    const returnId = await createSaleReturn(clientContactId);

    const res = await asA('post', `/api/v1/sale-returns/${returnId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it("400 — channel email, client sans adresse email enregistrée", async () => {
    const returnId = await createSaleReturn(clientAId);

    const res = await asA('post', `/api/v1/sale-returns/${returnId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Ce client n'a pas d'adresse email enregistrée.");
  });

  it('400 — channel sms, client sans numéro de téléphone enregistré', async () => {
    const returnId = await createSaleReturn(clientAId);

    const res = await asA('post', `/api/v1/sale-returns/${returnId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Ce client n'a pas de numéro de téléphone enregistré.");
  });

  it('422 — channel absent ou invalide', async () => {
    const returnId = await createSaleReturn(clientContactId);

    const resMissing = await asA('post', `/api/v1/sale-returns/${returnId}/send`).send({});
    expect(resMissing.status).toBe(422);

    const resInvalid = await asA('post', `/api/v1/sale-returns/${returnId}/send`).send({ channel: 'fax' });
    expect(resInvalid.status).toBe(422);
  });

  it('404 — retour inexistant', async () => {
    const res = await asA('post', '/api/v1/sale-returns/00000000-0000-0000-0000-000000000000/send').send({
      channel: 'email',
    });

    expect(res.status).toBe(404);
  });

  it('403 — isolation tenant : org B ne peut pas envoyer un retour de org A', async () => {
    const returnId = await createSaleReturn(clientContactId);

    const res = await asB('post', `/api/v1/sale-returns/${returnId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(403);
  });
});
