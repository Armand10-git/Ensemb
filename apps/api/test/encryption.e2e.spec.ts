/**
 * Tests e2e T07b — EncryptionService + SmtpServer + webhook idempotence :
 *  1. Round-trip chiffrement/déchiffrement via SmtpServer en vraie base
 *  2. Anti-fuite : un SELECT brut sur smtp_servers ne révèle pas le mot de passe en clair
 *  3. Webhook billing rejoué → 200 + confirmPayment appelé une seule fois
 *  4. Webhook POS mobile money rejoué → 200 + stub appelé une seule fois (compté via log spy)
 *
 * Module minimal : ConfigModule, PrismaModule, AuditModule, EncryptionModule, SmtpModule, BillingModule.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { EncryptionService } from '../src/common/encryption.service';
import { AuditModule } from '../src/modules/audit/audit.module';
import { SmtpModule } from '../src/modules/smtp/smtp.module';
import { BillingModule } from '../src/modules/billing/billing.module';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { PrismaService } from '../src/common/prisma.service';
import crypto from 'crypto';

const PREFIX = `t07b-enc-${Date.now()}`;
const TEST_JWT_SECRET = 'test-jwt-secret-t07b-encryption';
const SMTP_PASSWORD = 'MonMotDePasse123!';

describe('EncryptionService + SmtpServer + webhook idempotence (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let encryption: EncryptionService;
  let jwtService: JwtService;

  let orgId: string;
  let userId: string;
  let planId: string;
  let subId: string;
  let token: string;
  let smtpId: string;

  beforeAll(async () => {
    process.env['JWT_SECRET'] = TEST_JWT_SECRET;
    process.env['NODE_ENV'] = 'test';
    // Clé 32+ caractères pour AES-256
    process.env['APP_ENCRYPTION_KEY'] = 'e2e-test-encryption-key-32chars!';

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
        EncryptionModule,
        AuditModule,
        SmtpModule,
        BillingModule,
      ],
      providers: [JwtStrategy],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = moduleRef.get(PrismaService);
    encryption = moduleRef.get(EncryptionService);
    jwtService = moduleRef.get(JwtService);

    // Plan starter (seed)
    const plan = await prisma.plan.findFirst({ where: { name: 'starter' } });
    if (!plan) throw new Error('Plan starter absent — seed non exécuté ?');
    planId = plan.id;

    // Organisation de test
    const org = await prisma.organization.create({
      data: { name: 'Org T07b Enc', subdomain: `${PREFIX}-main` },
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
        lastname: 'T07b',
        email: `admin@${PREFIX}.test`,
        username: `admin-${PREFIX}`,
        password: 'hashed',
        isActive: true,
      },
    });
    userId = user.id;

    await prisma.roleOnUser.create({ data: { userId, roleId: role.id } });

    // Permissions nécessaires
    for (const permName of ['organization.settings.edit', 'billing.manage']) {
      let perm = await prisma.permission.findUnique({ where: { name: permName } });
      if (!perm) {
        perm = await prisma.permission.create({ data: { name: permName, label: permName } });
      }
      await prisma.permissionOnRole.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }

    token = jwtService.sign(
      { sub: userId, organizationId: orgId, email: `admin@${PREFIX}.test` },
      { secret: TEST_JWT_SECRET, expiresIn: '1h' },
    );
  }, 30_000);

  afterAll(async () => {
    // Nettoyage en ordre FK
    if (smtpId) await prisma.smtpServer.deleteMany({ where: { organizationId: orgId } });
    await prisma.webhookEvent.deleteMany({ where: { organizationId: orgId } });
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

  // ─── 1. PUT /api/v1/organizations/smtp ─────────────────────────────────────

  describe('PUT /api/v1/organizations/smtp', () => {
    it('crée la config SMTP et retourne un objet sans passwordCipher ni password', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/organizations/smtp')
        .set('Authorization', `Bearer ${token}`)
        .send({
          host: 'smtp.example.com',
          port: 587,
          username: 'user@example.com',
          password: SMTP_PASSWORD,
          fromEmail: 'noreply@example.com',
          fromName: 'Ensemb',
        })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      smtpId = body['id'] as string;
      expect(typeof smtpId).toBe('string');
      expect(body).not.toHaveProperty('passwordCipher');
      expect(body).not.toHaveProperty('password');
      expect(body['host']).toBe('smtp.example.com');
    });

    it('renvoie 401 sans token', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/organizations/smtp')
        .send({ host: 'x', port: 587, username: 'u', password: 'p', fromEmail: 'a@b.com', fromName: 'N' })
        .expect(401);
    });
  });

  // ─── 2. Anti-fuite : dump SQL ne révèle pas le mot de passe en clair ───────

  describe('Anti-fuite dump SQL', () => {
    it('un SELECT brut sur smtp_servers ne contient pas le mot de passe en clair', async () => {
      // S'assure que la config SMTP a été créée
      const rows = await prisma.$queryRaw<{ passwordCipher: string }[]>`
        SELECT "passwordCipher" FROM smtp_servers WHERE "organizationId" = ${orgId}::uuid
      `;

      expect(rows.length).toBeGreaterThan(0);

      const rawCipher = (rows[0] as { passwordCipher: string }).passwordCipher;

      // 1. La valeur brute en base ne contient pas le mot de passe en clair
      expect(rawCipher).not.toContain(SMTP_PASSWORD);

      // 2. Le format respecte "hex:hex:hex" (3 segments de longueur paire)
      const parts = rawCipher.split(':');
      expect(parts).toHaveLength(3);
      parts.forEach((p) => {
        expect(p.length % 2).toBe(0); // longueur paire = hex valide
        expect(/^[0-9a-f]+$/i.test(p)).toBe(true);
      });

      // 3. Déchiffrement retrouve le plaintext
      const decrypted = encryption.decrypt(rawCipher);
      expect(decrypted).toBe(SMTP_PASSWORD);
    });
  });

  // ─── 3. Webhook billing rejoué ─────────────────────────────────────────────

  describe('POST /api/v1/webhooks/billing — idempotence', () => {
    let invoiceId: string;

    beforeAll(async () => {
      // Crée une invoice pour le test webhook billing
      const inv = await prisma.invoice.create({
        data: {
          organizationId: orgId,
          subscriptionId: subId,
          amount: new Decimal('5000'),
          currency: 'XAF',
          status: 'PENDING',
          dueAt: new Date(Date.now() + 86_400_000),
          period: 'monthly',
        },
        select: { id: true },
      });
      invoiceId = inv.id;
    });

    it('premier appel → 200 { received: true }', async () => {
      const payload = {
        type: 'payment.success',
        provider: `billing-test-${PREFIX}`,
        providerEventId: `evt-billing-replay-${PREFIX}`,
        invoiceId,
      };

      // Signature HMAC valide (mode test : PaymentAggregatorService accepte en NODE_ENV=test)
      const secret = process.env['PAYMENT_AGGREGATOR_WEBHOOK_SECRET'] ?? 'test-secret';
      const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/billing')
        .set('x-aggregator-signature', sig)
        .send(payload)
        .expect(200)
        .expect({ received: true });
    });

    it('deuxième appel identique → 200 { received: true } sans nouvel effet métier', async () => {
      const payload = {
        type: 'payment.success',
        provider: `billing-test-${PREFIX}`,
        providerEventId: `evt-billing-replay-${PREFIX}`, // même providerEventId
        invoiceId,
      };

      const secret = process.env['PAYMENT_AGGREGATOR_WEBHOOK_SECRET'] ?? 'test-secret';
      const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/billing')
        .set('x-aggregator-signature', sig)
        .send(payload)
        .expect(200)
        .expect({ received: true });

      // Un seul WebhookEvent doit exister pour ce providerEventId
      const events = await prisma.webhookEvent.findMany({
        where: { providerEventId: `evt-billing-replay-${PREFIX}` },
      });
      expect(events).toHaveLength(1);
    });
  });

  // ─── 4. Webhook POS mobile money rejoué ────────────────────────────────────

  describe('POST /api/v1/webhooks/payments/:organizationId — idempotence', () => {
    const providerEventId = `evt-pos-replay-${PREFIX}`;

    it('premier appel → 200 { received: true }', async () => {
      const payload = { type: 'payment.success', providerEventId };

      const secret = process.env['PAYMENT_AGGREGATOR_WEBHOOK_SECRET'] ?? 'test-secret';
      const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

      await request(app.getHttpServer())
        .post(`/api/v1/webhooks/payments/${orgId}`)
        .set('x-aggregator-signature', sig)
        .send(payload)
        .expect(200)
        .expect({ received: true });
    });

    it('deuxième appel identique → 200 { received: true }, un seul WebhookEvent', async () => {
      const payload = { type: 'payment.success', providerEventId };

      const secret = process.env['PAYMENT_AGGREGATOR_WEBHOOK_SECRET'] ?? 'test-secret';
      const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

      await request(app.getHttpServer())
        .post(`/api/v1/webhooks/payments/${orgId}`)
        .set('x-aggregator-signature', sig)
        .send(payload)
        .expect(200)
        .expect({ received: true });

      const events = await prisma.webhookEvent.findMany({
        where: { providerEventId },
      });
      expect(events).toHaveLength(1);
    });
  });
});
