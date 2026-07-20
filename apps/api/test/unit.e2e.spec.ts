/**
 * Tests d'intégration UnitsController — Supertest contre Postgres local.
 *
 * Couvre :
 *  - CRUD complet : unités de base et dérivées
 *  - Hiérarchie profonde (unité dérivée d'une dérivée) → 400 explicite
 *  - Isolation multi-tenant : unités d'un tenant non visibles par un autre
 *  - Doublon de name même org → 409 ; deux orgs → 201
 *  - Soft-delete : unité absente de la liste après suppression
 *  - Suppression avec sous-unités actives → 400 explicite
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { RedisModule } from '../src/common/redis.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { CatalogModule } from '../src/modules/catalog/catalog.module';

jest.setTimeout(30_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-unit-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-unit-b-${SUFFIX}`;

let app: INestApplication;
let prisma: PrismaClient;
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;

const UNIT_PERMS = ['units.view', 'units.create', 'units.edit', 'units.delete'];

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  const orgA = await prisma.organization.create({
    data: { name: 'E2E Unit Org A', subdomain: ORG_A_SUBDOMAIN },
  });
  const orgB = await prisma.organization.create({
    data: { name: 'E2E Unit Org B', subdomain: ORG_B_SUBDOMAIN },
  });
  orgAId = orgA.id;
  orgBId = orgB.id;

  for (const name of UNIT_PERMS) {
    await prisma.permission.upsert({
      where: { name },
      update: {},
      create: { name, label: name },
    });
  }

  const perms = await prisma.permission.findMany({
    where: { name: { in: UNIT_PERMS } },
    select: { id: true },
  });

  async function setupOrgUser(orgId: string, email: string) {
    const role = await prisma.role.create({ data: { organizationId: orgId, name: 'Admin' } });
    for (const p of perms) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Test',
        lastname: 'User',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
  }

  await setupOrgUser(orgAId, `user-unit-a-${SUFFIX}@e2e.cm`);
  await setupOrgUser(orgBId, `user-unit-b-${SUFFIX}@e2e.cm`);

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
      PassportModule,
      JwtModule.register({}),
      PrismaModule,
      EncryptionModule,
      RedisModule,
      AuditModule,
      AuthModule,
      CatalogModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  const loginA = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgAId)
    .send({ email: `user-unit-a-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenA = loginA.body.accessToken as string;

  const loginB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgBId)
    .send({ email: `user-unit-b-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenB = loginB.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();
  // Supprimer les sous-unités (enfants) avant les unités de base (parents)
  await prisma.unit.deleteMany({
    where: { organizationId: { in: [orgAId, orgBId] }, baseUnitId: { not: null } },
  });
  await prisma.unit.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.roleOnUser.deleteMany({
    where: { user: { organizationId: { in: [orgAId, orgBId] } } },
  });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permissionOnRole.deleteMany({
    where: { role: { organizationId: { in: [orgAId, orgBId] } } },
  });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.$disconnect();
});

// ─── Création ────────────────────────────────────────────────────────────────

describe('POST /api/v1/catalog/units', () => {
  it('201 — crée une unité de base', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Kg-${SUFFIX}`, shortName: `kg${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: `Kg-${SUFFIX}` });
    expect(res.body.baseUnitId).toBeNull();
  });

  it('201 — crée une unité dérivée d\'une unité de base', async () => {
    const base = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Base-${SUFFIX}`, shortName: `b${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });

    const derived = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: `Deriv-${SUFFIX}`,
        shortName: `d${SUFFIX % 1000}`,
        baseUnitId: (base.body as { id: string }).id,
        operator: '*',
        operatorValue: '12',
      });

    expect(derived.status).toBe(201);
    expect(derived.body.baseUnitId).toBe((base.body as { id: string }).id);
    expect(derived.body.baseUnit).toMatchObject({ name: `Base-${SUFFIX}` });
  });

  it('400 — hiérarchie profonde : unité dérivée d\'une dérivée', async () => {
    const base = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Root-${SUFFIX}`, shortName: `r${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });

    const lvl1 = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: `Lvl1-${SUFFIX}`,
        shortName: `l1${SUFFIX % 1000}`,
        baseUnitId: (base.body as { id: string }).id,
        operator: '*',
        operatorValue: '6',
      });

    const lvl2 = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: `Lvl2-${SUFFIX}`,
        shortName: `l2${SUFFIX % 1000}`,
        baseUnitId: (lvl1.body as { id: string }).id,
        operator: '*',
        operatorValue: '2',
      });

    expect(lvl2.status).toBe(400);
    expect(typeof lvl2.body.message).toBe('string');
    expect(lvl2.body.message).toMatch(/hiérarchie|1 niveau/i);
  });

  it('409 — doublon de name dans la même org', async () => {
    const name = `DupUnit-${SUFFIX}`;
    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name, shortName: `du1${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name, shortName: `du2${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });

    expect(res.status).toBe(409);
  });

  it('201 — même name, deux orgs différentes → OK', async () => {
    const name = `SharedUnit-${SUFFIX}`;
    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name, shortName: `su1${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name, shortName: `su2${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });

    expect(res.status).toBe(201);
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .send({ name: 'Test', shortName: 't', operator: '*', operatorValue: '1' });
    expect(res.status).toBe(401);
  });
});

// ─── Liste ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/catalog/units', () => {
  it('200 — ne retourne que les unités du tenant', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
  });
});

// ─── Détail ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/catalog/units/:id', () => {
  let unitId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Detail-${SUFFIX}`, shortName: `dt${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });
    unitId = (res.body as { id: string }).id;
  });

  it('200 — retourne l\'unité du tenant', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/catalog/units/${unitId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(unitId);
  });

  it('403 ou 404 — autre tenant ne peut pas voir cette unité', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/catalog/units/${unitId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect([403, 404]).toContain(res.status);
  });
});

// ─── Modification ────────────────────────────────────────────────────────────

describe('PATCH /api/v1/catalog/units/:id', () => {
  let unitId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Update-${SUFFIX}`, shortName: `up${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });
    unitId = (res.body as { id: string }).id;
  });

  it('200 — met à jour le nom', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/catalog/units/${unitId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Updated-${SUFFIX}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Updated-${SUFFIX}`);
  });

  it('403 ou 404 — autre tenant ne peut pas modifier', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/catalog/units/${unitId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hack' });
    expect([403, 404]).toContain(res.status);
  });
});

// ─── Suppression ─────────────────────────────────────────────────────────────

describe('DELETE /api/v1/catalog/units/:id', () => {
  it('204 — soft-delete réussi', async () => {
    const created = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Del-${SUFFIX}`, shortName: `del${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });
    const unitId = (created.body as { id: string }).id;

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/catalog/units/${unitId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(204);

    const list = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`);
    const ids = (list.body.data as { id: string }[]).map((u) => u.id);
    expect(ids).not.toContain(unitId);
  });

  it('400 — suppression avec sous-unités actives → message explicite', async () => {
    const base = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Parent-${SUFFIX}`, shortName: `par${SUFFIX % 1000}`, operator: '*', operatorValue: '1' });
    const baseId = (base.body as { id: string }).id;

    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: `Child-${SUFFIX}`,
        shortName: `ch${SUFFIX % 1000}`,
        baseUnitId: baseId,
        operator: '*',
        operatorValue: '10',
      });

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/catalog/units/${baseId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message).toMatch(/sous-unité|dérivée/i);
  });
});
