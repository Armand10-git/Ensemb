/**
 * Tests d'intégration Expense/ExpenseCategory (S29).
 *
 * Couvre :
 *  - CRUD complet des deux entités : créer, lire, lister, modifier, soft-delete
 *  - Isolation multi-tenant sur les deux entités
 *  - Référence de dépense unique par organisation, générée via DocumentCounterService
 *    (format DEP-YYYY-NNNNNN, jamais MAX(reference)+1)
 *  - IDOR : expenseCategoryId/warehouseId d'une autre organisation refusés à la création
 *    et à la modification d'une dépense
 *  - Suppression d'une ExpenseCategory encore référencée par une Expense existante : la
 *    catégorie disparaît des listes, mais la dépense existante reste consultable avec son
 *    expenseCategoryId intact (soft delete uniquement, §17 point 7)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import bcrypt from 'bcryptjs';
import { getTestPrisma } from './helpers/prisma';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { RedisModule } from '../src/common/redis.module';
import { DocumentCounterModule } from '../src/common/document-counter.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { ExpensesModule } from '../src/modules/expenses/expenses.module';

jest.setTimeout(30_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-exp-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-exp-b-${SUFFIX}`;

let app: INestApplication;
const prisma = getTestPrisma();
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let warehouseAId: string;
let warehouseBId: string;
let categoryAId: string;
let categoryBId: string;

const PERMS = [
  'expenseCategories.view',
  'expenseCategories.create',
  'expenseCategories.edit',
  'expenseCategories.delete',
  'expenses.view',
  'expenses.create',
  'expenses.edit',
  'expenses.delete',
  'records.viewAll',
];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const orgA = await prisma.organization.create({ data: { name: 'E2E Expense Org A', subdomain: ORG_A_SUBDOMAIN } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Expense Org B', subdomain: ORG_B_SUBDOMAIN } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  for (const name of PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const perms = await prisma.permission.findMany({ where: { name: { in: PERMS } }, select: { id: true } });

  async function setupUser(orgId: string, email: string) {
    const role = await prisma.role.create({ data: { organizationId: orgId, name: 'Admin' } });
    for (const p of perms) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Test',
        lastname: 'Expense',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  await setupUser(orgAId, `exp-a-${SUFFIX}@e2e.cm`);
  await setupUser(orgBId, `exp-b-${SUFFIX}@e2e.cm`);

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `WH Exp A-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;
  const whB = await prisma.warehouse.create({
    data: { organizationId: orgBId, name: `WH Exp B-${SUFFIX}`, isDefault: true },
  });
  warehouseBId = whB.id;

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
      ExpensesModule,
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

  tokenA = await login(orgAId, `exp-a-${SUFFIX}@e2e.cm`);
  tokenB = await login(orgBId, `exp-b-${SUFFIX}@e2e.cm`);

  const catA = await asA('post', '/api/v1/expense-categories').send({ name: `Transport-${SUFFIX}` });
  categoryAId = (catA.body as { id: string }).id;
  const catB = await asB('post', '/api/v1/expense-categories').send({ name: `Transport-${SUFFIX}` });
  categoryBId = (catB.body as { id: string }).id;
});

afterAll(async () => {
  await app?.close();
  await prisma.expense.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.expenseCategory.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
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
function asB(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return supertest(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${tokenB}`)
    .set('X-Organization-Id', orgBId);
}

function expenseDto(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-08-01T00:00:00.000Z',
    expenseCategoryId: categoryAId,
    warehouseId: warehouseAId,
    details: 'Carburant véhicule de livraison',
    amount: '25000',
    ...overrides,
  };
}

// ─── ExpenseCategory CRUD ───────────────────────────────────────────────────────

describe('POST /api/v1/expense-categories', () => {
  it('201 — crée une catégorie de dépense', async () => {
    const res = await asA('post', '/api/v1/expense-categories').send({ name: `Loyer-${SUFFIX}` });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`Loyer-${SUFFIX}`);
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/expense-categories')
      .set('X-Organization-Id', orgAId)
      .send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/expense-categories', () => {
  it("200 — isolation tenant : org B ne voit pas les catégories de org A", async () => {
    const res = await asB('get', '/api/v1/expense-categories');
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((c) => c.id);
    expect(ids).not.toContain(categoryAId);
  });
});

describe('GET /api/v1/expense-categories/:id', () => {
  it('403 — IDOR : org B ne peut pas lire une catégorie de org A', async () => {
    const res = await asB('get', `/api/v1/expense-categories/${categoryAId}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/v1/expense-categories/:id', () => {
  it('200 — modifie une catégorie', async () => {
    const created = await asA('post', '/api/v1/expense-categories').send({ name: `ToUpdate-${SUFFIX}` });
    const id = (created.body as { id: string }).id;

    const res = await asA('patch', `/api/v1/expense-categories/${id}`).send({ name: `Updated-${SUFFIX}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Updated-${SUFFIX}`);
  });

  it('403 — IDOR : org B ne peut pas modifier une catégorie de org A', async () => {
    const res = await asB('patch', `/api/v1/expense-categories/${categoryAId}`).send({ name: 'Hack' });
    expect(res.status).toBe(403);
  });
});

// ─── Expense CRUD ───────────────────────────────────────────────────────────────

describe('POST /api/v1/expenses', () => {
  it('201 — crée une dépense avec référence DEP-YYYY-NNNNNN générée côté serveur', async () => {
    const res = await asA('post', '/api/v1/expenses').send(expenseDto());
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^DEP-\d{4}-\d{6}$/);
    expect(res.body.amount).toBe('25000');
    expect(res.body.expenseCategoryId).toBe(categoryAId);
    expect(res.body.warehouseId).toBe(warehouseAId);
  });

  it('références séquentielles uniques par organisation', async () => {
    const res1 = await asA('post', '/api/v1/expenses').send(expenseDto());
    const res2 = await asA('post', '/api/v1/expenses').send(expenseDto());
    expect(res1.body.reference).not.toBe(res2.body.reference);
  });

  it("403 — IDOR : expenseCategoryId d'une autre organisation refusé", async () => {
    const res = await asA('post', '/api/v1/expenses').send(expenseDto({ expenseCategoryId: categoryBId }));
    expect(res.status).toBe(403);
  });

  it("403 — IDOR : warehouseId d'une autre organisation refusé", async () => {
    const res = await asA('post', '/api/v1/expenses').send(expenseDto({ warehouseId: warehouseBId }));
    expect(res.status).toBe(403);
  });

  it('422 — payload invalide (amount manquant)', async () => {
    const dto = expenseDto();
    delete (dto as Record<string, unknown>).amount;
    const res = await asA('post', '/api/v1/expenses').send(dto);
    expect(res.status).toBe(422);
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/expenses')
      .set('X-Organization-Id', orgAId)
      .send(expenseDto());
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/expenses', () => {
  it('200 — paginé, isolation tenant : org B ne voit pas les dépenses de org A', async () => {
    await asA('post', '/api/v1/expenses').send(expenseDto());
    const res = await asB('get', '/api/v1/expenses');
    expect(res.status).toBe(200);
    const ids = (res.body.data as { organizationId?: string }[]).map((e) => e.organizationId);
    expect(ids.every((id) => id === undefined || id === orgBId)).toBe(true);
  });

  it('200 — filtrable par expenseCategoryId', async () => {
    const created = await asA('post', '/api/v1/expenses').send(expenseDto());
    const id = (created.body as { id: string }).id;

    const res = await asA('get', `/api/v1/expenses?expenseCategoryId=${categoryAId}`);
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((e) => e.id);
    expect(ids).toContain(id);
  });
});

describe('GET /api/v1/expenses/:id', () => {
  it('200 — retourne la dépense de son organisation', async () => {
    const created = await asA('post', '/api/v1/expenses').send(expenseDto());
    const id = (created.body as { id: string }).id;

    const res = await asA('get', `/api/v1/expenses/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it('404 — dépense inexistante', async () => {
    const res = await asA('get', '/api/v1/expenses/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('403 — IDOR : org B ne peut pas lire une dépense de org A', async () => {
    const created = await asA('post', '/api/v1/expenses').send(expenseDto());
    const id = (created.body as { id: string }).id;

    const res = await asB('get', `/api/v1/expenses/${id}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/v1/expenses/:id', () => {
  it('200 — modifie une dépense, aucune restriction de statut', async () => {
    const created = await asA('post', '/api/v1/expenses').send(expenseDto());
    const id = (created.body as { id: string }).id;

    const res = await asA('patch', `/api/v1/expenses/${id}`).send({ details: 'Péage autoroute' });
    expect(res.status).toBe(200);
    expect(res.body.details).toBe('Péage autoroute');
  });

  it("403 — IDOR : réassignation vers un expenseCategoryId d'une autre organisation refusée", async () => {
    const created = await asA('post', '/api/v1/expenses').send(expenseDto());
    const id = (created.body as { id: string }).id;

    const res = await asA('patch', `/api/v1/expenses/${id}`).send({ expenseCategoryId: categoryBId });
    expect(res.status).toBe(403);
  });

  it('403 — IDOR : org B ne peut pas modifier une dépense de org A', async () => {
    const created = await asA('post', '/api/v1/expenses').send(expenseDto());
    const id = (created.body as { id: string }).id;

    const res = await asB('patch', `/api/v1/expenses/${id}`).send({ details: 'Hack' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/v1/expenses/:id', () => {
  it('204 — soft-delete une dépense', async () => {
    const created = await asA('post', '/api/v1/expenses').send(expenseDto());
    const id = (created.body as { id: string }).id;

    const res = await asA('delete', `/api/v1/expenses/${id}`);
    expect(res.status).toBe(204);

    const list = await asA('get', '/api/v1/expenses');
    const ids = (list.body.data as { id: string }[]).map((e) => e.id);
    expect(ids).not.toContain(id);

    const getRes = await asA('get', `/api/v1/expenses/${id}`);
    expect(getRes.status).toBe(404);
  });

  it('403 — IDOR : org B ne peut pas supprimer une dépense de org A', async () => {
    const created = await asA('post', '/api/v1/expenses').send(expenseDto());
    const id = (created.body as { id: string }).id;

    const res = await asB('delete', `/api/v1/expenses/${id}`);
    expect(res.status).toBe(403);
  });
});

// ─── Suppression d'une catégorie encore référencée ─────────────────────────────

describe("Suppression d'une ExpenseCategory encore référencée par une Expense existante", () => {
  it("la catégorie disparaît des listes, mais la dépense existante reste consultable avec son expenseCategoryId", async () => {
    const cat = await asA('post', '/api/v1/expense-categories').send({ name: `Référencée-${SUFFIX}` });
    const catId = (cat.body as { id: string }).id;

    const expense = await asA('post', '/api/v1/expenses').send(expenseDto({ expenseCategoryId: catId }));
    expect(expense.status).toBe(201);
    const expenseId = (expense.body as { id: string }).id;

    const del = await asA('delete', `/api/v1/expense-categories/${catId}`);
    expect(del.status).toBe(204);

    // La catégorie ne doit plus apparaître dans la liste des catégories actives
    const catList = await asA('get', '/api/v1/expense-categories');
    const catIds = (catList.body.data as { id: string }[]).map((c) => c.id);
    expect(catIds).not.toContain(catId);

    // La dépense existante reste lisible avec son expenseCategoryId intact
    const getExpense = await asA('get', `/api/v1/expenses/${expenseId}`);
    expect(getExpense.status).toBe(200);
    expect(getExpense.body.expenseCategoryId).toBe(catId);

    // Elle reste aussi visible dans la liste des dépenses
    const expenseList = await asA('get', '/api/v1/expenses');
    const expenseIds = (expenseList.body.data as { id: string }[]).map((e) => e.id);
    expect(expenseIds).toContain(expenseId);
  });
});
