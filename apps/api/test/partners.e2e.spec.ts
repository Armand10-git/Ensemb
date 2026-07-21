/**
 * Tests e2e PartnersModule — Supertest contre Postgres + Redis locaux.
 * Couvre : CRUD clients/providers, import CSV, export Excel, isolation tenant, template.
 * Requiert DATABASE_URL dans l'environnement (jest.config.js → setupFiles).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../src/common/prisma.module';
import { RedisModule } from '../src/common/redis.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { RolesModule } from '../src/modules/roles/roles.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { PartnersModule } from '../src/modules/partners/partners.module';

jest.setTimeout(60_000);

// ─── Données de test ──────────────────────────────────────────────────────────

const SUFFIX = Date.now();
const SUBDOMAIN_A = `e2e-partners-a-${SUFFIX}`;
const SUBDOMAIN_B = `e2e-partners-b-${SUFFIX}`;
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let prisma: PrismaClient;
let app: INestApplication;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  // Organisation A
  const orgA = await prisma.organization.create({
    data: { name: 'Partners E2E Org A', subdomain: SUBDOMAIN_A },
  });
  orgAId = orgA.id;

  // Organisation B (pour tester l'isolation)
  const orgB = await prisma.organization.create({
    data: { name: 'Partners E2E Org B', subdomain: SUBDOMAIN_B },
  });
  orgBId = orgB.id;

  // Permissions nécessaires
  const perms = [
    'customers.view', 'customers.create', 'customers.edit', 'customers.delete', 'customers.import',
    'suppliers.view', 'suppliers.create', 'suppliers.edit', 'suppliers.delete', 'suppliers.import',
  ];
  const permRecords: { id: string }[] = [];
  for (const name of perms) {
    const p = await prisma.permission.upsert({
      where: { name },
      update: {},
      create: { name, label: name },
    });
    permRecords.push({ id: p.id });
  }

  // Rôle + user pour org A
  const roleA = await prisma.role.create({
    data: { organizationId: orgAId, name: 'PartnersAdmin' },
  });
  for (const p of permRecords) {
    await prisma.permissionOnRole.create({ data: { roleId: roleA.id, permissionId: p.id } });
  }
  const userA = await prisma.user.create({
    data: {
      organizationId: orgAId,
      firstname: 'User', lastname: 'A',
      email: `userA-${SUFFIX}@e2e.cm`, username: `userA-${SUFFIX}`,
      password: await bcrypt.hash('Pass@1234!', 12),
      isActive: true,
    },
  });
  await prisma.roleOnUser.create({ data: { userId: userA.id, roleId: roleA.id } });

  // Rôle + user pour org B
  const roleB = await prisma.role.create({
    data: { organizationId: orgBId, name: 'PartnersAdmin' },
  });
  for (const p of permRecords) {
    await prisma.permissionOnRole.create({ data: { roleId: roleB.id, permissionId: p.id } });
  }
  const userB = await prisma.user.create({
    data: {
      organizationId: orgBId,
      firstname: 'User', lastname: 'B',
      email: `userB-${SUFFIX}@e2e.cm`, username: `userB-${SUFFIX}`,
      password: await bcrypt.hash('Pass@1234!', 12),
      isActive: true,
    },
  });
  await prisma.roleOnUser.create({ data: { userId: userB.id, roleId: roleB.id } });

  // Application NestJS
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
      BullModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: { url: config.getOrThrow<string>('REDIS_URL') },
        }),
      }),
      PrismaModule,
      RedisModule,
      PassportModule,
      JwtModule.register({}),
      AuthModule,
      RolesModule,
      AuditModule,
      PartnersModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  // Login org A
  const resA = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `userA-${SUFFIX}@e2e.cm`, password: 'Pass@1234!' });
  tokenA = (resA.body as { accessToken: string }).accessToken;

  // Login org B
  const resB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `userB-${SUFFIX}@e2e.cm`, password: 'Pass@1234!' });
  tokenB = (resB.body as { accessToken: string }).accessToken;
});

afterAll(async () => {
  await app.close();
  // Nettoyage : clients → providers → roleOnUser → users → permissionsOnRole → roles → org
  await prisma.client.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.provider.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.$disconnect();
});

// ─── Tests CRUD Clients ───────────────────────────────────────────────────────

describe('CRUD Clients', () => {
  let clientId: string;

  it('POST /clients — crée un client (201)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/partners/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Acme Corp', email: 'acme@test.cm', city: 'Douala' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Acme Corp', code: expect.any(Number) });
    clientId = (res.body as { id: string }).id;
  });

  it('GET /clients — liste paginée (200)', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/partners/clients?page=1&limit=20')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });

  it('GET /clients/:id — détail (200)', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/partners/clients/${clientId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(clientId);
  });

  it('PATCH /clients/:id — modifie un client (200)', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/partners/clients/${clientId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ city: 'Yaoundé' });

    expect(res.status).toBe(200);
    expect((res.body as { city: string }).city).toBe('Yaoundé');
  });

  it('DELETE /clients/:id — soft-delete (204)', async () => {
    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/partners/clients/${clientId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(204);
  });

  it('GET /clients/:id — 404 après soft-delete', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/partners/clients/${clientId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});

// ─── Tests CRUD Providers ─────────────────────────────────────────────────────

describe('CRUD Providers', () => {
  let providerId: string;

  it('POST /providers — crée un fournisseur (201)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/partners/providers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Fournisseur Sarl', phone: '+237600000001' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Fournisseur Sarl' });
    providerId = (res.body as { id: string }).id;
  });

  it('PATCH /providers/:id — modifie un fournisseur (200)', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/partners/providers/${providerId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ city: 'Bafoussam' });

    expect(res.status).toBe(200);
    expect((res.body as { city: string }).city).toBe('Bafoussam');
  });

  it('DELETE /providers/:id — soft-delete (204)', async () => {
    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/partners/providers/${providerId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(204);
  });
});

// ─── Import CSV ───────────────────────────────────────────────────────────────

describe('Import CSV Clients', () => {
  it('import CSV valide → 200, données persistées', async () => {
    const csv = 'name,email,phone,country,city,address\nAlpha,alpha@test.cm,+237100,,Douala,\nBeta,beta@test.cm,,,\n';

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/partners/clients/import')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from(csv), { filename: 'clients.csv', contentType: 'text/csv' });

    expect(res.status).toBe(201);
    expect((res.body as { imported: number }).imported).toBe(2);
    expect((res.body as { errors: unknown[] }).errors).toHaveLength(0);
  });

  it('import CSV avec lignes invalides → 200, valides importées, invalides ignorées', async () => {
    const csv = 'name,email,phone,country,city,address\nGamma,gamma@test.cm,,,\nDelta,not-an-email,,,\n';

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/partners/clients/import')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from(csv), { filename: 'clients.csv', contentType: 'text/csv' });

    expect(res.status).toBe(201);
    expect((res.body as { imported: number }).imported).toBe(1);
    expect((res.body as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('upload non-CSV → 422', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/partners/clients/import')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from('<html>fake</html>'), { filename: 'clients.html', contentType: 'text/html' });

    expect(res.status).toBe(422);
  });
});

// ─── Export Excel ─────────────────────────────────────────────────────────────

describe('Export Excel', () => {
  it('GET /clients/export/excel → 202 + jobId', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/partners/clients/export/excel')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(202);
    expect((res.body as { jobId: string }).jobId).toBeDefined();
  });
});

// ─── Template CSV ─────────────────────────────────────────────────────────────

describe('Template CSV', () => {
  it('GET /clients/template → CSV avec les bons en-têtes', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/partners/clients/template')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('name,email,phone,country,city,address');
  });
});

// ─── Isolation tenant ─────────────────────────────────────────────────────────

describe('Isolation tenant', () => {
  let clientAId: string;

  beforeAll(async () => {
    // Crée un client dans org A
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/partners/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Client isolé org A' });
    clientAId = (res.body as { id: string }).id;
  });

  it('org B ne peut pas accéder au client de org A (403)', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/partners/clients/${clientAId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
  });

  it('org B ne voit pas les clients de org A dans sa liste', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/partners/clients')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    const ids = ((res.body as { data: { id: string }[] }).data).map(c => c.id);
    expect(ids).not.toContain(clientAId);
  });
});
