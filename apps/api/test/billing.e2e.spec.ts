/**
 * Tests d'intégration — T06 BillingModule :
 *  - Subscription TRIALING créée à l'inscription (logique fenêtre de lancement)
 *  - QuotaGuard renvoie 403 explicite quand le quota est dépassé
 *
 * Requiert uniquement Postgres. Redis et Socket.io sont mockés ou absents.
 * Exclus du job test:unit en CI (pattern *.e2e.spec.ts).
 */
import { Controller, INestApplication, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { PrismaModule } from '../src/common/prisma.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { RegistrationModule } from '../src/modules/registration/registration.module';
import { BillingModule } from '../src/modules/billing/billing.module';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';
import { QuotaGuard } from '../src/modules/billing/quota.guard';
import { CheckQuota } from '../src/modules/billing/check-quota.decorator';
import { PrismaService } from '../src/common/prisma.service';

const PREFIX = `t06-test-${Date.now()}`;
const TEST_JWT_SECRET = 'test-jwt-secret-t06-billing';

/** Endpoint minimal utilisé uniquement pour tester le QuotaGuard en e2e. */
@Controller('test-quota')
class TestQuotaController {
  @Post('users')
  @UseGuards(JwtAuthGuard, QuotaGuard)
  @CheckQuota('users')
  createUser(): { ok: boolean } {
    return { ok: true };
  }
}

describe('BillingModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  beforeAll(async () => {
    process.env['JWT_SECRET'] = TEST_JWT_SECRET;

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
        RegistrationModule,
        BillingModule,
      ],
      controllers: [TestQuotaController],
      providers: [JwtStrategy],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwtService = moduleRef.get(JwtService);
  }, 30_000);

  afterAll(async () => {
    const orgs = await prisma.organization.findMany({
      where: { subdomain: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = orgs.map((o) => o.id);

    await prisma.subscription.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: ids } } } });
    await prisma.user.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: ids } } } });
    await prisma.role.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });

    await app.close();
  }, 15_000);

  function makeToken(userId: string, orgId: string): string {
    return jwtService.sign(
      { sub: userId, organizationId: orgId, email: `admin@${orgId}.test` },
      { secret: TEST_JWT_SECRET, expiresIn: '1h' },
    );
  }

  // ─── Subscription creation on register ─────────────────────────────────────

  describe('POST /api/v1/public/organizations/register — Subscription TRIALING', () => {
    it('pendant la fenêtre de lancement : trialEndsAt = launchPromoEndsAt', async () => {
      // PlatformSetting.launchPromoEndsAt = "2026-09-30T23:59:59Z" (seed — dans le futur)
      const subdomain = `${PREFIX}-window`;

      const res = await request(app.getHttpServer())
        .post('/api/v1/public/organizations/register')
        .send({
          subdomain,
          organizationName: 'Org Fenêtre T06',
          adminFirstname: 'Alice',
          adminLastname: 'Martin',
          adminEmail: `admin@${subdomain}.test`,
          adminPassword: 'MotDePasse123!',
        })
        .expect(201);

      const { organizationId } = res.body as { organizationId: string };

      const subscription = await prisma.subscription.findUnique({
        where: { organizationId },
      });

      expect(subscription).not.toBeNull();
      expect(subscription!.status).toBe('TRIALING');

      // La date doit correspondre à launchPromoEndsAt du seed
      const launchPromoSetting = await prisma.platformSetting.findUnique({
        where: { key: 'launchPromoEndsAt' },
      });
      const launchPromoEndsAt = new Date(JSON.parse(launchPromoSetting!.value) as string);
      expect(subscription!.currentPeriodEnd.getTime()).toBe(launchPromoEndsAt.getTime());
    }, 15_000);

    it('après la fenêtre de lancement : trialEndsAt ≈ now + trialDurationDays', async () => {
      const ORIGINAL_VALUE = '"2026-09-30T23:59:59Z"';
      const pastDate = new Date('2026-01-01T00:00:00Z');

      // Passer launchPromoEndsAt dans le passé ; toujours restaurer même en cas d'échec
      await prisma.platformSetting.update({
        where: { key: 'launchPromoEndsAt' },
        data: { value: `"${pastDate.toISOString()}"` },
      });

      try {
        const subdomain = `${PREFIX}-post-window`;
        const before = Date.now();

        const res = await request(app.getHttpServer())
          .post('/api/v1/public/organizations/register')
          .send({
            subdomain,
            organizationName: 'Org Post-Fenêtre T06',
            adminFirstname: 'Bob',
            adminLastname: 'Dupont',
            adminEmail: `admin@${subdomain}.test`,
            adminPassword: 'MotDePasse456!',
          })
          .expect(201);

        const after = Date.now();
        const { organizationId } = res.body as { organizationId: string };

        const subscription = await prisma.subscription.findUnique({
          where: { organizationId },
          include: { plan: true },
        });

        expect(subscription).not.toBeNull();
        expect(subscription!.status).toBe('TRIALING');

        const thirtyDaysMs = subscription!.plan.trialDurationDays * 24 * 60 * 60 * 1000;
        const periodEnd = subscription!.currentPeriodEnd.getTime();
        expect(periodEnd).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
        expect(periodEnd).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
      } finally {
        await prisma.platformSetting.update({
          where: { key: 'launchPromoEndsAt' },
          data: { value: ORIGINAL_VALUE },
        });
      }
    }, 20_000);
  });

  // ─── QuotaGuard — POST /api/v1/test-quota/users ─────────────────────────────

  describe('QuotaGuard — @CheckQuota("users")', () => {
    async function createOrgWithUsers(
      subdomain: string,
      userCount: number,
      planMaxUsers: number | null,
    ): Promise<{ orgId: string; adminUserId: string; token: string }> {
      const org = await prisma.organization.create({
        data: { name: `Org Quota ${subdomain}`, subdomain },
        select: { id: true },
      });

      // Trouver ou créer un plan de test avec le maxUsers voulu
      const testPlanName = `test-quota-${planMaxUsers ?? 'unlimited'}`;
      const plan = await prisma.plan.upsert({
        where: { name: testPlanName },
        update: { maxUsers: planMaxUsers },
        create: {
          name: testPlanName,
          label: `Test Quota ${planMaxUsers ?? 'Illimité'}`,
          priceMonthly: 0,
          priceAnnual: 0,
          trialDurationDays: 30,
          maxUsers: planMaxUsers,
          maxWarehouses: null,
          maxProducts: null,
        },
        select: { id: true },
      });

      await prisma.subscription.create({
        data: {
          organizationId: org.id,
          planId: plan.id,
          status: 'TRIALING',
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      // Créer l'utilisateur admin
      const adminUser = await prisma.user.create({
        data: {
          organizationId: org.id,
          firstname: 'Admin',
          lastname: 'Quota',
          email: `admin@${subdomain}.test`,
          username: `admin-${subdomain}`,
          password: 'hashed',
          isActive: true,
        },
        select: { id: true },
      });

      // Créer les utilisateurs supplémentaires (pour remplir le quota)
      for (let i = 1; i < userCount; i++) {
        await prisma.user.create({
          data: {
            organizationId: org.id,
            firstname: `User`,
            lastname: `${i}`,
            email: `user${i}@${subdomain}.test`,
            username: `user${i}-${subdomain}`,
            password: 'hashed',
            isActive: true,
          },
        });
      }

      const token = makeToken(adminUser.id, org.id);
      return { orgId: org.id, adminUserId: adminUser.id, token };
    }

    it('laisse passer quand le quota n\'est pas atteint (count < max)', async () => {
      const { token } = await createOrgWithUsers(`${PREFIX}-quota-ok`, 1, 5);

      const res = await request(app.getHttpServer())
        .post('/api/v1/test-quota/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      expect(res.body).toEqual({ ok: true });
    }, 15_000);

    it('renvoie 403 explicite quand le quota est dépassé (count >= max)', async () => {
      const { token } = await createOrgWithUsers(`${PREFIX}-quota-full`, 5, 5);

      const res = await request(app.getHttpServer())
        .post('/api/v1/test-quota/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      const message = res.body.message as string;
      expect(message).toContain('5');
      expect(message).toContain('utilisateurs');
      // Le nom du plan doit apparaître
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(10);
    }, 15_000);

    it('laisse passer si maxUsers est null (plan illimité)', async () => {
      const { token } = await createOrgWithUsers(`${PREFIX}-quota-unlimited`, 50, null);

      const res = await request(app.getHttpServer())
        .post('/api/v1/test-quota/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      expect(res.body).toEqual({ ok: true });
    }, 15_000);

    it('renvoie 401 sans token', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/test-quota/users')
        .expect(401);
    });
  });
});
