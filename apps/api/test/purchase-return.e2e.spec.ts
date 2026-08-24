/**
 * Tests d'intégration PurchaseReturn (S26 — Bloc F/E, §18.6, mirror du patron
 * sale-return.e2e.spec.ts / purchase.e2e.spec.ts).
 *
 * Couvre :
 *  - POST /purchase-returns : 201, référence RAC-…, grandTotal calculé, IDOR (purchaseId d'une
 *    autre org, purchaseDetailId d'un AUTRE Purchase que celui déclaré), source non-COMPLETED,
 *    quantité dépassant la quantité achetée (cas simple ET cas cumulé)
 *  - PATCH /purchase-returns/:id/validate : décrémente ProductWarehouse.quantity, PENDING →
 *    COMPLETED, refuse un retour déjà COMPLETED, isolation tenant, stock insuffisant,
 *    ProductWarehouse absent → NotFoundException (PAS de création automatique, contrairement à
 *    SaleReturn)
 *  - LE TEST DE CONCURRENCE : mirror exact du patron S21 (sale.e2e.spec.ts) — PurchaseReturnService
 *    ne retente JAMAIS (mirror SaleService, pas PurchaseService) → [200, 409] déterministe.
 *  - GET /purchase-returns paginé, isolation tenant, records.viewAll
 *  - DELETE /purchase-returns/:id — 204 si PENDING, 400 si COMPLETED
 *
 * Seul ReturnsModule est importé (avec les modules d'infra communs) — PurchasesModule n'est PAS
 * nécessaire : l'achat d'origine et ses lignes sont créés directement via prisma.purchase.create/
 * prisma.purchaseDetail.create (statut COMPLETED).
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
const ORG_A_SUBDOMAIN = `e2e-pret-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-pret-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenA2: string;
let tokenB: string;
let adminAId: string;
let providerAId: string;
let warehouseAId: string;
let productAId: string;
let pwValId: string; // ProductWarehouse dédié aux tests de validate() (productAId @ warehouseAId)

const PERMS = ['purchaseReturns.view', 'purchaseReturns.create', 'purchaseReturns.edit', 'purchaseReturns.delete', 'purchaseReturns.validate', 'records.viewAll'];
const PERMS_NO_VIEWALL = ['purchaseReturns.view', 'purchaseReturns.create', 'purchaseReturns.edit', 'purchaseReturns.delete'];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E PurchaseReturn Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E PurchaseReturn Org B', subdomain: ORG_B_SUBDOMAIN } });
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
        lastname: 'PurchaseReturn',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  adminAId = await setupUser(orgAId, `pret-a-${SUFFIX}@e2e.cm`, 'Admin', permsFull);
  await setupUser(orgAId, `pret-a2-${SUFFIX}@e2e.cm`, 'Acheteur', permsNoViewAll);
  await setupUser(orgBId, `pret-b-${SUFFIX}@e2e.cm`, 'Admin', permsFull);

  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CAT-PRET-${SUFFIX}`, name: 'Cat PurchaseReturn A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-PRET-${SUFFIX}`,
      name: 'Produit Retour Achat A',
      cost: '1000',
      price: '1500',
      taxRate: '0',
      taxMethod: 'percentage',
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH PurchaseReturn-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  const providerA = await prisma.provider.create({
    data: { organizationId: orgAId, name: `Fournisseur PurchaseReturn ${SUFFIX}`, code: 1 },
  });
  providerAId = providerA.id;

  // Stock initial généreux — un retour fournisseur DÉCRÉMENTE ; assez de stock pour absorber
  // tous les scénarios de test (remis à l'état voulu au début de chaque test qui vérifie une
  // quantité exacte, patron identique à sale-return.e2e.spec.ts).
  const pwVal = await prisma.productWarehouse.create({
    data: { productId: productAId, warehouseId: warehouseAId, quantity: new Decimal('1000'), version: 0 },
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

  tokenA  = await login(orgAId, `pret-a-${SUFFIX}@e2e.cm`);
  tokenA2 = await login(orgAId, `pret-a2-${SUFFIX}@e2e.cm`);
  tokenB  = await login(orgBId, `pret-b-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  await prisma.paymentReturn.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.purchaseReturnDetail.deleteMany({ where: { purchaseReturn: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.purchaseReturn.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.purchaseDetail.deleteMany({ where: { purchase: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.purchase.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.provider.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
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

/** Crée directement en base un achat COMPLETED avec une seule ligne connue. */
async function createCompletedPurchaseWithDetail(
  orgId: string,
  userId: string,
  quantity: string,
  price = '1000',
  productId = productAId,
): Promise<{ purchaseId: string; purchaseDetailId: string }> {
  const total = new Decimal(price).times(quantity);
  const purchase = await prisma.purchase.create({
    data: {
      organizationId: orgId,
      reference: `TST-PURC-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: new Date('2026-07-26'),
      userId,
      providerId: providerAId,
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
  const detail = await prisma.purchaseDetail.create({
    data: {
      purchaseId: purchase.id,
      productId,
      price: new Decimal(price),
      taxAmount: new Decimal('0'),
      taxMethod: 'percentage',
      discount: new Decimal('0'),
      discountMethod: 'percentage',
      quantity: new Decimal(quantity),
      total,
    },
  });
  return { purchaseId: purchase.id, purchaseDetailId: detail.id };
}

async function createPurchaseWithStatus(
  orgId: string,
  userId: string,
  status: 'PENDING' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'CANCELLED',
  quantity: string,
): Promise<{ purchaseId: string; purchaseDetailId: string }> {
  const price = '1000';
  const total = new Decimal(price).times(quantity);
  const purchase = await prisma.purchase.create({
    data: {
      organizationId: orgId,
      reference: `TST-PURC-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: new Date('2026-07-26'),
      userId,
      providerId: providerAId,
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
  const detail = await prisma.purchaseDetail.create({
    data: {
      purchaseId: purchase.id,
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
  return { purchaseId: purchase.id, purchaseDetailId: detail.id };
}

// ─── POST /purchase-returns ───────────────────────────────────────────────────

describe('POST /api/v1/purchase-returns', () => {
  it('201 — crée un retour PENDING avec référence RAC-… et grandTotal = somme des lignes', async () => {
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10', '1000');

    const res = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '4' }],
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.reference).toMatch(/^RAC-\d{4}-\d+$/);
    expect(res.body.grandTotal).toBe('4000');

    const inDb = await prisma.purchaseReturn.findUnique({ where: { id: res.body.id } });
    expect(inDb!.grandTotal.toString()).toBe('4000');
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/purchase-returns')
      .set('X-Organization-Id', orgAId)
      .send({});
    expect(res.status).toBe(401);
  });

  it('422 — payload invalide (details vide)', async () => {
    const { purchaseId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');
    const res = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [],
    });
    expect(res.status).toBe(422);
  });

  it('IDOR — tenant B ne peut pas créer un retour sur un achat de tenant A', async () => {
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');

    const res = await asB('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("IDOR croisé — purchaseId du PREMIER document mais purchaseDetailId d'une ligne du DEUXIÈME → rejeté", async () => {
    const first = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');
    const second = await createCompletedPurchaseWithDetail(orgAId, adminAId, '5');

    const res = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId: first.purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId: second.purchaseDetailId, quantity: '1' }],
    });

    expect(res.status).toBe(403);

    const created = await prisma.purchaseReturn.findFirst({ where: { purchaseId: first.purchaseId } });
    expect(created).toBeNull();
  });

  it('400 — retour sur un achat PENDING (pas COMPLETED)', async () => {
    const { purchaseId, purchaseDetailId } = await createPurchaseWithStatus(orgAId, adminAId, 'PENDING', '10');

    const res = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });
    expect(res.status).toBe(400);
  });

  it('400 — retour sur un achat CANCELLED', async () => {
    const { purchaseId, purchaseDetailId } = await createPurchaseWithStatus(orgAId, adminAId, 'CANCELLED', '10');

    const res = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });
    expect(res.status).toBe(400);
  });

  it('400 — quantité retournée dépasse la quantité achetée (cas simple, une seule ligne)', async () => {
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '5');

    const res = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '6' }],
    });
    expect(res.status).toBe(400);
  });

  it(
    '400 — cas CUMULÉ : deux retours successifs COMPLETED (pas concurrents) sur la même ligne, ' +
      'le deuxième dépasse le total restant',
    async () => {
      const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');

      const first = await asA('post', '/api/v1/purchase-returns').send({
        purchaseId,
        date: '2026-07-27T00:00:00.000Z',
        details: [{ purchaseDetailId, quantity: '6' }],
      });
      expect(first.status).toBe(201);
      const firstValidate = await asA('patch', `/api/v1/purchase-returns/${first.body.id as string}/validate`).send();
      expect(firstValidate.status).toBe(200);

      const second = await asA('post', '/api/v1/purchase-returns').send({
        purchaseId,
        date: '2026-07-27T00:00:00.000Z',
        details: [{ purchaseDetailId, quantity: '6' }],
      });
      expect(second.status).toBe(201);

      const secondValidate = await asA('patch', `/api/v1/purchase-returns/${second.body.id as string}/validate`).send();
      expect(secondValidate.status).toBe(400);

      const secondReload = await prisma.purchaseReturn.findUnique({ where: { id: second.body.id as string } });
      expect(secondReload!.status).toBe('PENDING');
    },
  );

  it(
    '400 — fractionnement SÉQUENTIEL (pas concurrent) : 5 retours PENDING de 3 unités créés sur ' +
      'une ligne source de 10 achetées, validés un par un dans l\'ordre — les 3 premiers doivent ' +
      "réussir (cumul 9/10), le 4e doit échouer (9+3=12>10) SANS être tronqué silencieusement à 1, " +
      'et le stock ne doit refléter que les 3 validations réellement COMPLETED (-9, pas -12)',
    async () => {
      // Stock généreux pour absorber les 3 décréments réels sans jamais déclencher le garde-fou
      // « stock insuffisant » (hors-sujet de ce test — c'est la garde cumulée qu'on isole ici).
      await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('1000'), version: 0 } });

      const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');

      // Crée les 5 retours PENDING AVANT toute validation — verifyAndComputeLines() est
      // best-effort par ligne (3 ≤ 10 passe systématiquement à la création, qui ignore les
      // autres retours existants sur la même purchaseDetailId).
      const returnIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await asA('post', '/api/v1/purchase-returns').send({
          purchaseId,
          date: '2026-07-27T00:00:00.000Z',
          details: [{ purchaseDetailId, quantity: '3' }],
        });
        expect(res.status).toBe(201);
        returnIds.push(res.body.id as string);
      }

      // Capture le stock juste AVANT les validations (pas une constante figée : productAId/
      // warehouseAId sont partagés avec d'autres tests de ce fichier — seul le delta introduit
      // par CE test doit être vérifié).
      const pwBeforeValidations = await prisma.productWarehouse.findFirst({
        where: { productId: productAId, warehouseId: warehouseAId },
      });
      const pwValBaseline = pwBeforeValidations!.quantity;

      // Valide séquentiellement (attend chaque réponse avant de lancer la suivante — pas de
      // Promise.all ici, contrairement au test de concurrence ci-dessus) : la garde cumulée
      // (verifyCumulativeQuantities) doit relire l'état réel en base à CHAQUE appel de
      // validate(), pas un état capturé une seule fois.
      const statuses: number[] = [];
      for (const id of returnIds) {
        const res = await asA('patch', `/api/v1/purchase-returns/${id}/validate`).send();
        statuses.push(res.status);
      }

      // 3×3=9 ≤ 10 : les trois premiers passent. 9+3=12 > 10 : le 4e échoue. Le 5e échoue aussi
      // (9 déjà retourné, toujours > 10 - 3 = 7 restant).
      expect(statuses).toEqual([200, 200, 200, 400, 400]);

      const reloaded = await prisma.purchaseReturn.findMany({
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
      const fourthDetail = await prisma.purchaseReturnDetail.findFirst({
        where: { purchaseReturnId: returnIds[3] },
      });
      expect(fourthDetail!.quantity.toString()).toBe('3');

      // Le stock ne reflète que -9 (3 validations COMPLETED), jamais -12.
      const pw = await prisma.productWarehouse.findFirst({
        where: { productId: productAId, warehouseId: warehouseAId },
      });
      expect(pw!.quantity.toString()).toBe(new Decimal(pwValBaseline).minus('9').toString());
    },
  );
});

// ─── GET /purchase-returns — pagination, isolation, records.viewAll ──────────

describe('GET /api/v1/purchase-returns', () => {
  it('200 — paginé, tenant B ne voit pas les retours de tenant A', async () => {
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '5');
    await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });

    const res = await asB('get', '/api/v1/purchase-returns');

    expect(res.status).toBe(200);
    const data = res.body.data as { organizationId: string }[];
    expect(data.every((r) => r.organizationId !== orgAId)).toBe(true);
  });

  it("records.viewAll=false — l'utilisateur ne voit que ses propres retours", async () => {
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '5');
    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });
    expect(created.status).toBe(201);

    const res = await asA2('get', '/api/v1/purchase-returns');
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(created.body.id);

    const resAdmin = await asA('get', '/api/v1/purchase-returns');
    const idsAdmin = (resAdmin.body.data as { id: string }[]).map((r) => r.id);
    expect(idsAdmin).toContain(created.body.id);
  });
});

// ─── PATCH /purchase-returns/:id/validate ────────────────────────────────────

describe('PATCH /api/v1/purchase-returns/:id/validate', () => {
  it('200 — décrémente ProductWarehouse.quantity et passe status à COMPLETED', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('100'), version: 0 } });

    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');
    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '4' }],
    });
    const returnId = created.body.id as string;

    const res = await asA('patch', `/api/v1/purchase-returns/${returnId}/validate`).send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('96');

    const purchaseReturn = await prisma.purchaseReturn.findUnique({ where: { id: returnId } });
    expect(purchaseReturn!.status).toBe('COMPLETED');
  });

  it('400 — stock insuffisant : quantité en base et statut PENDING inchangés', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('2'), version: 0 } });

    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');
    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '5' }],
    });
    const returnId = created.body.id as string;

    const res = await asA('patch', `/api/v1/purchase-returns/${returnId}/validate`).send();

    expect(res.status).toBe(400);
    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('2');
    const purchaseReturn = await prisma.purchaseReturn.findUnique({ where: { id: returnId } });
    expect(purchaseReturn!.status).toBe('PENDING');
  });

  it('400 — refuse un retour déjà COMPLETED (pas de revalidation, pas de double décrément)', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('50'), version: 0 } });

    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');
    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '3' }],
    });
    const returnId = created.body.id as string;

    const first = await asA('patch', `/api/v1/purchase-returns/${returnId}/validate`).send();
    expect(first.status).toBe(200);

    const second = await asA('patch', `/api/v1/purchase-returns/${returnId}/validate`).send();
    expect(second.status).toBe(400);

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('47'); // 50 - 3, jamais 44
  });

  it('403 — isolation tenant : org B ne peut pas valider un retour de org A', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('50'), version: 0 } });

    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');
    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '2' }],
    });
    const returnId = created.body.id as string;

    const res = await asB('patch', `/api/v1/purchase-returns/${returnId}/validate`).send();
    expect(res.status).toBe(403);

    const pw = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
    expect(new Decimal(pw!.quantity).toString()).toBe('50');
    const purchaseReturn = await prisma.purchaseReturn.findUnique({ where: { id: returnId } });
    expect(purchaseReturn!.status).toBe('PENDING');
  });

  it('404 — ProductWarehouse absent de l\'entrepôt (spécifique à PurchaseReturn, pas de création automatique)', async () => {
    const catB = await prisma.category.create({
      data: { organizationId: orgAId, code: `CAT-PRET-NEW-${SUFFIX}`, name: 'Cat PurchaseReturn Nouveau' },
    });
    const newProduct = await prisma.product.create({
      data: {
        organizationId: orgAId,
        code: `PROD-PRET-NEW-${SUFFIX}`,
        name: 'Produit Retour Achat Jamais Stocké',
        cost: '500',
        price: '800',
        taxRate: '0',
        taxMethod: 'percentage',
        categoryId: catB.id,
      },
    });

    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(
      orgAId,
      adminAId,
      '5',
      '500',
      newProduct.id,
    );
    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });
    expect(created.status).toBe(201);

    const res = await asA('patch', `/api/v1/purchase-returns/${created.body.id as string}/validate`).send();
    expect(res.status).toBe(404);

    await prisma.purchaseReturnDetail.deleteMany({ where: { purchaseReturnId: created.body.id as string } });
    await prisma.purchaseReturn.deleteMany({ where: { id: created.body.id as string } });
    await prisma.purchaseDetail.deleteMany({ where: { purchaseId } });
    await prisma.purchase.deleteMany({ where: { id: purchaseId } });
    await prisma.product.deleteMany({ where: { id: newProduct.id } });
    await prisma.category.deleteMany({ where: { id: catB.id } });
  });

  // ─── Test de concurrence — mirror exact S21 (sale.e2e.spec.ts) ──────────────
  //
  // PurchaseReturnService.validate() NE retente JAMAIS sur un conflit de concurrence (mirror
  // SaleService.validate(), écart assumé vs PurchaseService.validate() — cf. JSDoc de la
  // classe) : une ConflictException 409 est remontée directement dès le premier conflit de
  // sérialisation Postgres. Deux retours PENDING distincts sur la MÊME PurchaseDetail source
  // (quantity=10 achetée), chacun avec une ligne de 6 (6+6=12 > 10), validés en parallèle
  // contre une vraie base Postgres : peu importe le chemin exact emprunté (garde de quantité ou
  // conflit d'écriture sur le même ProductWarehouse), le résultat attendu est déterministe :
  // exactement une 200 et une 409 (jamais 200/200).
  it(
    'concurrence — deux retours PENDING sur la même PurchaseDetail (6+6=12 > 10 achetées), validés ' +
      'en parallèle : exactement un COMPLETED et un 409, stock décrémenté une seule fois (delta = 6)',
    async () => {
      await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('100'), version: 0 } });

      const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '10');

      const ret1 = await asA('post', '/api/v1/purchase-returns').send({
        purchaseId,
        date: '2026-07-27T00:00:00.000Z',
        details: [{ purchaseDetailId, quantity: '6' }],
      });
      const ret2 = await asA('post', '/api/v1/purchase-returns').send({
        purchaseId,
        date: '2026-07-27T00:00:00.000Z',
        details: [{ purchaseDetailId, quantity: '6' }],
      });
      expect(ret1.status).toBe(201);
      expect(ret2.status).toBe(201);

      const pwBefore = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
      const qtyBefore = new Decimal(pwBefore!.quantity);

      // Lancées réellement en parallèle contre une vraie base Postgres — c'est la
      // sérialisation Postgres (Serializable, SANS retry côté PurchaseReturnService) qui doit
      // arbitrer, jamais un mock.
      const [res1, res2] = await Promise.all([
        asA('patch', `/api/v1/purchase-returns/${ret1.body.id as string}/validate`).send(),
        asA('patch', `/api/v1/purchase-returns/${ret2.body.id as string}/validate`).send(),
      ]);

      const statuses = [res1.status, res2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const pwAfter = await prisma.productWarehouse.findUnique({ where: { id: pwValId } });
      const qtyAfter = new Decimal(pwAfter!.quantity);
      // Un seul décrément de 6 a été appliqué — jamais 12 (double mouvement), jamais 0 (aucun).
      expect(qtyBefore.minus(qtyAfter).toString()).toBe('6');

      const [reload1, reload2] = await Promise.all([
        prisma.purchaseReturn.findUnique({ where: { id: ret1.body.id as string } }),
        prisma.purchaseReturn.findUnique({ where: { id: ret2.body.id as string } }),
      ]);
      const finalStatuses = [reload1!.status, reload2!.status].sort();
      expect(finalStatuses).toEqual(['COMPLETED', 'PENDING']);

      const completedDetails = await prisma.purchaseReturnDetail.findMany({
        where: { purchaseDetailId, purchaseReturn: { status: 'COMPLETED' } },
      });
      const totalReturned = completedDetails.reduce((acc, d) => acc.plus(new Decimal(d.quantity)), new Decimal(0));
      expect(totalReturned.lessThanOrEqualTo(new Decimal('10'))).toBe(true);
      expect(totalReturned.toString()).toBe('6');
    },
  );
});

// ─── DELETE /purchase-returns/:id ────────────────────────────────────────────

describe('DELETE /api/v1/purchase-returns/:id', () => {
  it('204 — supprime un retour PENDING', async () => {
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '5');
    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });

    const res = await asA('delete', `/api/v1/purchase-returns/${created.body.id as string}`);
    expect(res.status).toBe(204);
  });

  it('400 — un retour COMPLETED ne peut pas être supprimé', async () => {
    await prisma.productWarehouse.update({ where: { id: pwValId }, data: { quantity: new Decimal('50'), version: 0 } });
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '5');
    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });
    const returnId = created.body.id as string;
    const validated = await asA('patch', `/api/v1/purchase-returns/${returnId}/validate`).send();
    expect(validated.status).toBe(200);

    const res = await asA('delete', `/api/v1/purchase-returns/${returnId}`);
    expect(res.status).toBe(400);
  });
});

// ─── POST /purchase-returns/:id/send (S32/S33) ─────────────────────────────────
// Envoie le récapitulatif d'un retour fournisseur au fournisseur par email ou SMS — enfile un
// job BullMQ fire-and-forget sur la file 'email'/'sms' (mode test, aucun appel réseau réel).
// Fournisseur dédié à ce describe (email + téléphone renseignés) affecté à l'achat d'origine
// après création — providerAId (utilisé par createCompletedPurchaseWithDetail) n'a ni email ni
// téléphone renseignés, réutilisé tel quel pour les tests 400.

describe('POST /api/v1/purchase-returns/:id/send', () => {
  let providerContactId: string;

  beforeAll(async () => {
    const provider = await prisma.provider.create({
      data: {
        organizationId: orgAId,
        name: `Fournisseur PurchaseReturn Contact ${SUFFIX}`,
        code: 2,
        email: `provider-return-send-${SUFFIX}@e2e.cm`,
        phone: '+237600000005',
      },
    });
    providerContactId = provider.id;
  });

  async function createPurchaseReturn(providerId: string): Promise<string> {
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '2');
    await prisma.purchase.update({ where: { id: purchaseId }, data: { providerId } });

    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });
    return created.body.id as string;
  }

  it('202 — channel email, fournisseur avec email renseigné → job enfilé', async () => {
    const returnId = await createPurchaseReturn(providerContactId);

    const res = await asA('post', `/api/v1/purchase-returns/${returnId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it('202 — channel sms, fournisseur avec téléphone renseigné → job enfilé', async () => {
    const returnId = await createPurchaseReturn(providerContactId);

    const res = await asA('post', `/api/v1/purchase-returns/${returnId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it("400 — channel email, fournisseur sans adresse email enregistrée", async () => {
    const returnId = await createPurchaseReturn(providerAId);

    const res = await asA('post', `/api/v1/purchase-returns/${returnId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Ce fournisseur n'a pas d'adresse email enregistrée.");
  });

  it('400 — channel sms, fournisseur sans numéro de téléphone enregistré', async () => {
    const returnId = await createPurchaseReturn(providerAId);

    const res = await asA('post', `/api/v1/purchase-returns/${returnId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Ce fournisseur n'a pas de numéro de téléphone enregistré.");
  });

  it('422 — channel absent ou invalide', async () => {
    const returnId = await createPurchaseReturn(providerContactId);

    const resMissing = await asA('post', `/api/v1/purchase-returns/${returnId}/send`).send({});
    expect(resMissing.status).toBe(422);

    const resInvalid = await asA('post', `/api/v1/purchase-returns/${returnId}/send`).send({
      channel: 'fax',
    });
    expect(resInvalid.status).toBe(422);
  });

  it('404 — retour inexistant', async () => {
    const res = await asA('post', '/api/v1/purchase-returns/00000000-0000-0000-0000-000000000000/send').send({
      channel: 'email',
    });

    expect(res.status).toBe(404);
  });

  it('403 — isolation tenant : org B ne peut pas envoyer un retour de org A', async () => {
    const returnId = await createPurchaseReturn(providerContactId);

    const res = await asB('post', `/api/v1/purchase-returns/${returnId}/send`).send({ channel: 'email' });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/purchase-returns/:id/pdf', () => {
  async function createPurchaseReturn(): Promise<string> {
    const { purchaseId, purchaseDetailId } = await createCompletedPurchaseWithDetail(orgAId, adminAId, '2');

    const created = await asA('post', '/api/v1/purchase-returns').send({
      purchaseId,
      date: '2026-07-27T00:00:00.000Z',
      details: [{ purchaseDetailId, quantity: '1' }],
    });
    return created.body.id as string;
  }

  it('202 — enfile le job de génération PDF', async () => {
    const returnId = await createPurchaseReturn();

    const res = await asA('post', `/api/v1/purchase-returns/${returnId}/pdf`).send();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
  });

  it('404 — retour inexistant', async () => {
    const res = await asA('post', '/api/v1/purchase-returns/00000000-0000-0000-0000-000000000000/pdf').send();

    expect(res.status).toBe(404);
  });

  it('403 — isolation tenant : org B ne peut pas générer le PDF d\'un retour de org A', async () => {
    const returnId = await createPurchaseReturn();

    const res = await asB('post', `/api/v1/purchase-returns/${returnId}/pdf`).send();

    expect(res.status).toBe(403);
  });
});
