/**
 * Tests d'intégration Notification (S18).
 *
 * Couvre :
 *  - Ajustement SOUSTRACTION dépassant le seuil → Notification créée en base
 *  - GET /notifications → 200, liste contenant la notification
 *  - GET /notifications/unread-count → { count: 1 } avant lecture, { count: 0 } après
 *  - PATCH /notifications/:id/read → readAt posé en base
 *  - PATCH /notifications/read-all → toutes les notifications marquées lues
 *  - Isolation tenant : user B ne voit pas les notifications de user A
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { RedisModule } from '../src/common/redis.module';
import { DocumentCounterModule } from '../src/common/document-counter.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { NotificationModule } from '../src/modules/notifications/notification.module';
import { RealtimeModule } from '../src/modules/realtime/realtime.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_A_SUBDOMAIN = `e2e-notif-a-${SUFFIX}`;
const ORG_B_SUBDOMAIN = `e2e-notif-b-${SUFFIX}`;

let app: INestApplication;
let prisma: PrismaClient;
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let productAId: string;
let warehouseAId: string;
let userAId: string;

const STOCK_ALERT_THRESHOLD = 5;
const INITIAL_STOCK = 10;

const PERMS = [
  'adjustments.view',
  'adjustments.create',
  'adjustments.validate',
  'adjustments.delete',
  'reports.quantityAlerts',
];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  const orgA = await prisma.organization.create({
    data: { name: 'E2E Notif Org A', subdomain: ORG_A_SUBDOMAIN },
  });
  const orgB = await prisma.organization.create({
    data: { name: 'E2E Notif Org B', subdomain: ORG_B_SUBDOMAIN },
  });
  orgAId = orgA.id;
  orgBId = orgB.id;

  // S'assurer que les permissions existent (upsert idempotent)
  for (const name of PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const perms = await prisma.permission.findMany({
    where: { name: { in: PERMS } },
    select: { id: true, name: true },
  });

  async function setupOrgUser(
    orgId: string,
    email: string,
    permNames: string[],
  ): Promise<string> {
    const role = await prisma.role.create({
      data: { organizationId: orgId, name: `Admin-${email}` },
    });
    const filtered = perms.filter((p) => permNames.includes(p.name));
    for (const p of filtered) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Test',
        lastname: 'Notif',
        email,
        username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
    return user.id;
  }

  // User A : toutes les permissions (ajustements + notifications)
  userAId = await setupOrgUser(orgAId, `notif-a-${SUFFIX}@e2e.cm`, PERMS);
  // User B : org distincte, permissions basiques uniquement
  await setupOrgUser(orgBId, `notif-b-${SUFFIX}@e2e.cm`, [
    'adjustments.view',
    'adjustments.create',
    'adjustments.validate',
    'reports.quantityAlerts',
  ]);

  // Données org A : produit avec seuil, entrepôt, stock initial
  const catA = await prisma.category.create({
    data: { organizationId: orgAId, code: `CATAN-${SUFFIX}`, name: 'Cat Notif A' },
  });
  const prodA = await prisma.product.create({
    data: {
      organizationId: orgAId,
      code: `PROD-NOTIF-${SUFFIX}`,
      name: 'Riz Palmier',
      cost: '500',
      price: '800',
      taxRate: '0',
      taxMethod: 'percentage',
      stockAlert: STOCK_ALERT_THRESHOLD,
      categoryId: catA.id,
    },
  });
  productAId = prodA.id;

  const whA = await prisma.warehouse.create({
    data: { organizationId: orgAId, name: `Entrepôt Notif A-${SUFFIX}`, isDefault: true },
  });
  warehouseAId = whA.id;

  await prisma.productWarehouse.create({
    data: {
      productId: productAId,
      warehouseId: warehouseAId,
      quantity: new Decimal(INITIAL_STOCK),
      version: 0,
    },
  });

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
      RealtimeModule,
      InventoryModule,
      NotificationModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  const loginA = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgAId)
    .send({ email: `notif-a-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenA = loginA.body.accessToken as string;

  const loginB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgBId)
    .send({ email: `notif-b-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenB = loginB.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();
  // Nettoyage dans l'ordre des dépendances FK
  await prisma.notification.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.adjustmentDetail.deleteMany({ where: { adjustment: { organizationId: orgAId } } });
  await prisma.adjustment.deleteMany({ where: { organizationId: orgAId } });
  await prisma.productWarehouse.deleteMany({ where: { warehouseId: warehouseAId } });
  await prisma.product.deleteMany({ where: { organizationId: orgAId } });
  await prisma.category.deleteMany({ where: { organizationId: orgAId } });
  await prisma.warehouse.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.roleOnUser.deleteMany({
    where: { user: { organizationId: { in: [orgAId, orgBId] } } },
  });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permissionOnRole.deleteMany({
    where: { role: { organizationId: { in: [orgAId, orgBId] } } },
  });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.documentCounter.deleteMany({
    where: { organizationId: { in: [orgAId, orgBId] } },
  });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.$disconnect();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Crée et valide un ajustement SOUSTRACTION qui déclenche stockAlert. */
async function createAndValidateSubtraction(qty: number): Promise<string> {
  const create = await supertest(app.getHttpServer())
    .post('/api/v1/inventory/adjustments')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      warehouseId: warehouseAId,
      date: new Date().toISOString(),
      details: [
        {
          productId: productAId,
          type: 'SOUSTRACTION',
          quantity: String(qty),
        },
      ],
    });

  expect(create.status).toBe(201);
  const adjId = create.body.id as string;

  const validate = await supertest(app.getHttpServer())
    .patch(`/api/v1/inventory/adjustments/${adjId}/validate`)
    .set('Authorization', `Bearer ${tokenA}`);
  expect(validate.status).toBe(200);

  // Petite pause pour laisser le createForOrg async se terminer
  await new Promise((r) => setTimeout(r, 200));

  return adjId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let notifId: string;

describe('Flow §18.10 — alerte stock bas → notification persistante', () => {
  it('valider un ajustement dépassant le seuil crée une Notification en base pour userA', async () => {
    await createAndValidateSubtraction(8); // 10 - 8 = 2 < seuil 5

    const notifs = await prisma.notification.findMany({
      where: { organizationId: orgAId, userId: userAId, type: 'stock.lowAlert' },
    });

    expect(notifs.length).toBeGreaterThanOrEqual(1);
    const first = notifs[0];
    expect(first).toBeDefined();
    expect(first?.payload).toMatchObject({ productId: productAId });
    notifId = first?.id ?? '';
  });

  it('GET /notifications → 200 avec la notification créée', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    const found = (res.body.data as Array<{ id: string }>).find((n) => n.id === notifId);
    expect(found).toBeDefined();
  });

  it('GET /notifications/unread-count → { count: ≥1 } avant lecture', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /notifications/:id/read → readAt posé en base', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.readAt).toBeTruthy();

    const inDb = await prisma.notification.findUnique({ where: { id: notifId } });
    expect(inDb?.readAt).toBeTruthy();
  });

  it('GET /notifications/unread-count → { count: 0 } après lecture', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('PATCH /notifications/read-all → toutes les notifications marquées lues', async () => {
    // Crée une seconde notification pour tester markAllAsRead
    await prisma.notification.updateMany({
      where: { id: notifId },
      data: { readAt: null },
    });

    const res = await supertest(app.getHttpServer())
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.updated).toBeGreaterThanOrEqual(1);

    const unread = await prisma.notification.count({
      where: { organizationId: orgAId, userId: userAId, readAt: null },
    });
    expect(unread).toBe(0);
  });
});

describe('Isolation tenant', () => {
  it('GET /notifications — user B ne voit pas les notifications de user A (org distincte)', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((n) => n.id);
    expect(ids).not.toContain(notifId);
  });

  it('PATCH /notifications/:id/read — user B ne peut pas marquer la notification de user A', async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${tokenB}`);

    // 404 (not found in org B) ou 403 — les deux sont acceptables
    expect([403, 404]).toContain(res.status);
  });
});
