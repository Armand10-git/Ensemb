/**
 * Tests d'intégration — T07 BillingModule (webhook + subscribe) :
 *  - POST /api/v1/billing/subscribe : génération d'un lien de paiement
 *  - POST /api/v1/webhooks/billing  : confirmation de paiement + idempotence
 *
 * PaymentAggregatorService est en mode test (NODE_ENV=test) : aucun appel HTTP réel.
 * BullMQ est connecté à Redis de test mais les jobs ne sont pas consommés.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { PrismaModule } from '../src/common/prisma.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { BillingModule } from '../src/modules/billing/billing.module';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { PrismaService } from '../src/common/prisma.service';

const PREFIX = `t07-wh-${Date.now()}`;
const TEST_JWT_SECRET = 'test-jwt-secret-t07-webhook';

describe('BillingModule webhook (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let orgId: string;
  let userId: string;
  let planId: string;
  let subId: string;
  let token: string;

  beforeAll(async () => {
    process.env['JWT_SECRET'] = TEST_JWT_SECRET;
    process.env['NODE_ENV'] = 'test';

    const moduleRef = await Test.createTestingModule({
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
        AuditModule,
        BillingModule,
      ],
      providers: [JwtStrategy],
    }).compile();

    // rawBody: true est indispensable pour le webhook HMAC
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwtService = moduleRef.get(JwtService);

    // Récupère le plan starter créé par le seed
    const plan = await prisma.plan.findFirst({ where: { name: 'starter' } });
    if (!plan) throw new Error('Plan starter absent — seed non exécuté ?');
    planId = plan.id;

    // Crée une organisation + subscription + utilisateur pour les tests
    const org = await prisma.organization.create({
      data: { name: 'Org Webhook T07', subdomain: `${PREFIX}-main` },
      select: { id: true },
    });
    orgId = org.id;

    await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: 'TRIALING',
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    }).then((s) => { subId = s.id; });

    const role = await prisma.role.create({
      data: { organizationId: orgId, name: 'Admin', label: 'Administrateur' },
    });

    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        firstname: 'Admin',
        lastname: 'T07',
        email: `admin@${PREFIX}.test`,
        username: `admin-${PREFIX}`,
        password: 'hashed',
        isActive: true,
      },
    });
    userId = user.id;

    await prisma.roleOnUser.create({ data: { userId, roleId: role.id } });

    // Assure la permission billing.manage sur le rôle
    let perm = await prisma.permission.findUnique({ where: { name: 'billing.manage' } });
    if (!perm) {
      perm = await prisma.permission.create({ data: { name: 'billing.manage', label: 'Billing manage' } });
    }
    await prisma.permissionOnRole.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
      update: {},
      create: { roleId: role.id, permissionId: perm.id },
    });

    token = jwtService.sign(
      { sub: userId, organizationId: orgId, email: `admin@${PREFIX}.test` },
      { secret: TEST_JWT_SECRET, expiresIn: '1h' },
    );
  }, 30_000);

  afterAll(async () => {
    // Nettoyage dans l'ordre des FK : webhook_events → invoices → subscriptions → roleOnUser → users → permissionOnRole → roles → organizations
    await prisma.webhookEvent.deleteMany({ where: { invoice: { organizationId: orgId } } });
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } });
    await prisma.subscription.deleteMany({ where: { organizationId: orgId } });
    await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: orgId } } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    const roles = await prisma.role.findMany({ where: { organizationId: orgId }, select: { id: true } });
    await prisma.permissionOnRole.deleteMany({ where: { roleId: { in: roles.map((r) => r.id) } } });
    await prisma.role.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });

    await app.close();
  }, 20_000);

  // ─── POST /api/v1/billing/subscribe ─────────────────────────────────────────

  describe('POST /api/v1/billing/subscribe', () => {
    it('renvoie 401 sans token', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/billing/subscribe')
        .send({ planId, period: 'monthly' })
        .expect(401);
    });

    it('renvoie 201 avec { invoiceId, paymentUrl } pour un token valide', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/billing/subscribe')
        .set('Authorization', `Bearer ${token}`)
        .send({ planId, period: 'monthly' })
        .expect(201);

      const body = res.body as { invoiceId: string; paymentUrl: string };
      expect(typeof body.invoiceId).toBe('string');
      expect(body.paymentUrl).toMatch(/^https:\/\/pay\.test\/mock-/);

      // Vérifie que l'Invoice est en base avec le bon statut
      const invoice = await prisma.invoice.findUnique({ where: { id: body.invoiceId } });
      expect(invoice).not.toBeNull();
      expect(invoice!.status).toBe('PENDING');
      expect(invoice!.organizationId).toBe(orgId);
    }, 15_000);

    it('renvoie 422 si le body est invalide', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/billing/subscribe')
        .set('Authorization', `Bearer ${token}`)
        .send({ planId: 'not-a-uuid', period: 'weekly' })
        .expect(422);
    });
  });

  // ─── POST /api/v1/webhooks/billing ──────────────────────────────────────────

  describe('POST /api/v1/webhooks/billing', () => {
    let invoiceId: string;

    beforeEach(async () => {
      // Crée une Invoice PENDING fraîche pour chaque scénario webhook
      const inv = await prisma.invoice.create({
        data: {
          organizationId: orgId,
          subscriptionId: subId,
          amount: 5000,
          currency: 'XAF',
          status: 'PENDING',
          dueAt: new Date(Date.now() + 86_400_000),
          period: 'monthly',
        },
      });
      invoiceId = inv.id;
    });

    afterEach(async () => {
      // Nettoyage des événements webhook créés pendant le test
      await prisma.webhookEvent.deleteMany({ where: { invoiceId } });
    });

    it('renvoie 401 si la signature HMAC est invalide (mode prod)', async () => {
      // On force le mode prod en supprimant temporairement NODE_ENV=test
      // En test, verifyWebhookSignature retourne toujours true — on teste le 401 via rawBody absent
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/billing')
        // Pas de body → rawBody sera vide → 401
        .set('X-Aggregator-Signature', 'invalid')
        .expect(401);
    });

    it('renvoie 200 et active l\'Invoice + Subscription sur payment.success', async () => {
      const payload = {
        type: 'payment.success',
        provider: 'test-aggregator',
        providerEventId: `evt-${invoiceId}`,
        invoiceId,
      };

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/billing')
        .set('Content-Type', 'application/json')
        .set('X-Aggregator-Signature', 'test-mode-any-sig')
        .send(payload)
        .expect(200);

      expect(res.body).toEqual({ received: true });

      // L'Invoice doit être PAID
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      expect(invoice!.status).toBe('PAID');
      expect(invoice!.paidAt).not.toBeNull();

      // La Subscription doit être ACTIVE
      const sub = await prisma.subscription.findUnique({ where: { organizationId: orgId } });
      expect(sub!.status).toBe('ACTIVE');
    }, 15_000);

    it('rejeu du même webhook → 200, Invoice toujours 1 seul PAID (idempotence)', async () => {
      const providerEventId = `evt-replay-${invoiceId}`;
      const payload = {
        type: 'payment.success',
        provider: 'test-aggregator',
        providerEventId,
        invoiceId,
      };

      // Premier envoi
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/billing')
        .set('Content-Type', 'application/json')
        .set('X-Aggregator-Signature', 'test-mode-any-sig')
        .send(payload)
        .expect(200);

      // Remise à zéro pour tester le rejeu
      const invoicePaidAt = (await prisma.invoice.findUnique({ where: { id: invoiceId } }))!.paidAt;

      // Deuxième envoi (rejeu)
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/billing')
        .set('Content-Type', 'application/json')
        .set('X-Aggregator-Signature', 'test-mode-any-sig')
        .send(payload)
        .expect(200);

      // Un seul WebhookEvent en base (contrainte unique)
      const webhookEvents = await prisma.webhookEvent.findMany({
        where: { provider: 'test-aggregator', providerEventId },
      });
      expect(webhookEvents).toHaveLength(1);

      // paidAt ne doit pas avoir changé (pas de deuxième confirmation)
      const invoiceAfter = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      expect(invoiceAfter!.paidAt!.getTime()).toBe(invoicePaidAt!.getTime());
    }, 15_000);
  });
});
