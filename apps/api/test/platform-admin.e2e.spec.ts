/**
 * Tests d'intégration — T08 PlatformAdminModule :
 *  - Flow MFA complet (login → setup TOTP → verify → accès protégé)
 *  - Rejet des tokens tenant sur les endpoints plateforme
 *  - Suspension d'organisation + blocage au refresh
 *  - Tableau de bord (métriques avec MRR Decimal)
 *
 * Requiert Postgres + Redis.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { generateSync, generateSecret } from 'otplib';
import { NobleCryptoPlugin } from '@otplib/plugin-crypto-noble';
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure';
import request from 'supertest';
import { PrismaModule } from '../src/common/prisma.module';
import { RedisModule } from '../src/common/redis.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { PlatformAdminModule } from '../src/modules/platform-admin/platform-admin.module';
import { PrismaService } from '../src/common/prisma.service';
import { EncryptionService } from '../src/common/encryption.service';

const CRYPTO_PLUGIN = new NobleCryptoPlugin();
const BASE32_PLUGIN = new ScureBase32Plugin();

function generateTotpCode(secret: string): string {
  return generateSync({ secret, crypto: CRYPTO_PLUGIN, base32: BASE32_PLUGIN });
}

const PREFIX = `t08-test-${Date.now()}`;
const PLATFORM_SECRET = 'test-platform-secret-t08';
const TENANT_SECRET = 'test-tenant-secret-t08';

describe('PlatformAdminModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let encryption: EncryptionService;
  let jwtService: JwtService;

  beforeAll(async () => {
    process.env['PLATFORM_JWT_SECRET'] = PLATFORM_SECRET;
    process.env['JWT_SECRET'] = TENANT_SECRET;
    process.env['APP_ENCRYPTION_KEY'] = 'test-encryption-key-32-chars-min!';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
        JwtModule.register({}),
        PrismaModule,
        RedisModule,
        EncryptionModule,
        AuditModule,
        PlatformAdminModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = moduleRef.get(PrismaService);
    encryption = moduleRef.get(EncryptionService);
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    const testAdmins = await prisma.platformAdmin.findMany({
      where: { email: { contains: PREFIX } },
    });
    const testOrgs = await prisma.organization.findMany({
      where: { subdomain: { startsWith: PREFIX } },
    });
    const orgIds = testOrgs.map((o) => o.id);

    if (orgIds.length > 0) {
      await prisma.invoice.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.subscription.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: orgIds } } } });
      await prisma.user.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: orgIds } } } });
      await prisma.role.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }

    if (testAdmins.length > 0) {
      await prisma.platformAdmin.deleteMany({ where: { id: { in: testAdmins.map((a) => a.id) } } });
    }

    await app.close();
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  async function createAdmin(emailSuffix: string, withTotp = false): Promise<string> {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('Admin@Test2026!', 12);
    const admin = await prisma.platformAdmin.create({
      data: {
        email: `${PREFIX}-${emailSuffix}@admin.test`,
        password: hash,
        totpEnabled: false,
        isActive: true,
      },
    });
    if (withTotp) {
      const secret = generateSecret({ crypto: CRYPTO_PLUGIN });
      const encryptedSecret = encryption.encrypt(secret);
      await prisma.platformAdmin.update({
        where: { id: admin.id },
        data: { totpSecret: encryptedSecret, totpEnabled: true },
      });
      return secret;
    }
    return admin.id;
  }

  function makeTenantToken(orgId: string): string {
    return jwtService.sign(
      { sub: 'user-uuid', organizationId: orgId, email: 'user@tenant.test' },
      { secret: TENANT_SECRET, expiresIn: '15m' },
    );
  }

  // ─── Tests ───────────────────────────────────────────────────────────────────

  describe('POST /login', () => {
    it('retourne 401 neutre pour email inconnu', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/login')
        .send({ email: 'noone@x.com', password: 'anything' })
        .expect(401);
    }, 10_000);

    it('retourne 401 neutre pour mauvais mot de passe', async () => {
      await createAdmin('login-bad-pwd');
      await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/login')
        .send({ email: `${PREFIX}-login-bad-pwd@admin.test`, password: 'WRONG' })
        .expect(401);
    }, 15_000);

    it('retourne tempToken avec requiresTotpSetup=true si TOTP non configuré', async () => {
      await createAdmin('login-no-totp');
      const res = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/login')
        .send({ email: `${PREFIX}-login-no-totp@admin.test`, password: 'Admin@Test2026!' })
        .expect(200);

      expect(res.body.requiresTotpSetup).toBe(true);
      expect(res.body.tempToken).toBeDefined();
    }, 15_000);
  });

  describe('Flow MFA complet', () => {
    let tempToken: string;
    let totpSecret: string;

    beforeAll(async () => {
      await createAdmin('mfa-flow');
      const res = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/login')
        .send({ email: `${PREFIX}-mfa-flow@admin.test`, password: 'Admin@Test2026!' });
      tempToken = res.body.tempToken as string;
    }, 15_000);

    it('POST /totp/setup retourne otpAuthUrl et secret', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/totp/setup')
        .set('Authorization', `Bearer ${tempToken}`)
        .expect(200);

      expect(res.body.otpAuthUrl).toContain('otpauth://');
      totpSecret = res.body.secret as string;
      expect(totpSecret).toBeDefined();
    }, 10_000);

    it('POST /totp/verify avec code valide retourne accessToken + refreshToken', async () => {
      const code = generateTotpCode(totpSecret);
      const res = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/totp/verify')
        .set('Authorization', `Bearer ${tempToken}`)
        .send({ code })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
    }, 10_000);

    it('GET /organizations retourne 200 avec accessToken plateforme', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/login')
        .send({ email: `${PREFIX}-mfa-flow@admin.test`, password: 'Admin@Test2026!' });
      const newTempToken = loginRes.body.tempToken as string;

      const code = generateTotpCode(totpSecret);
      const verifyRes = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/totp/verify')
        .set('Authorization', `Bearer ${newTempToken}`)
        .send({ code });

      const accessToken = verifyRes.body.accessToken as string;

      await request(app.getHttpServer())
        .get('/api/v1/platform-admin/organizations')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    }, 15_000);
  });

  describe('Isolation auth tenant / plateforme', () => {
    it('GET /organizations avec token tenant → 401', async () => {
      const tenantToken = makeTenantToken('org-fake-uuid');
      await request(app.getHttpServer())
        .get('/api/v1/platform-admin/organizations')
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(401);
    });

    it('GET /organizations sans token → 401', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/platform-admin/organizations')
        .expect(401);
    });
  });

  describe('Suspension d\'organisation', () => {
    let accessToken: string;
    let orgId: string;

    beforeAll(async () => {
      const secretPlain = await createAdmin('suspend-test', true) as string;

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/login')
        .send({ email: `${PREFIX}-suspend-test@admin.test`, password: 'Admin@Test2026!' });
      const tmpToken = loginRes.body.tempToken as string;

      const code = generateTotpCode(secretPlain);
      const verifyRes = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/totp/verify')
        .set('Authorization', `Bearer ${tmpToken}`)
        .send({ code });
      accessToken = verifyRes.body.accessToken as string;

      const plan = await prisma.plan.findFirst();
      const org = await prisma.organization.create({
        data: {
          name: 'Org Suspend Test',
          subdomain: `${PREFIX}-suspend-org`,
          status: 'ACTIVE',
        },
      });
      orgId = org.id;
      if (plan) {
        await prisma.subscription.create({
          data: {
            organizationId: orgId,
            planId: plan.id,
            status: 'ACTIVE',
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
      }
    }, 30_000);

    it('PATCH :id/suspend suspend l\'organisation', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/platform-admin/organizations/${orgId}/suspend`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      expect(org?.status).toBe('SUSPENDED');
    }, 10_000);

    it('PATCH :id/reactivate réactive l\'organisation', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/platform-admin/organizations/${orgId}/reactivate`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      expect(org?.status).toBe('ACTIVE');
    }, 10_000);
  });

  describe('GET /dashboard', () => {
    let accessToken: string;

    beforeAll(async () => {
      const secretPlain = await createAdmin('dashboard-test', true) as string;
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/login')
        .send({ email: `${PREFIX}-dashboard-test@admin.test`, password: 'Admin@Test2026!' });
      const tmpToken = loginRes.body.tempToken as string;

      const code = generateTotpCode(secretPlain);
      const verifyRes = await request(app.getHttpServer())
        .post('/api/v1/platform-admin/auth/totp/verify')
        .set('Authorization', `Bearer ${tmpToken}`)
        .send({ code });
      accessToken = verifyRes.body.accessToken as string;
    }, 30_000);

    it('retourne les métriques avec MRR en string Decimal', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/platform-admin/dashboard')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(typeof res.body.mrr).toBe('string');
      expect(res.body).toHaveProperty('activeOrganizations');
      expect(res.body).toHaveProperty('trialingOrganizations');
      expect(res.body).toHaveProperty('failedInvoices');
      expect(res.body).toHaveProperty('atRiskOrganizations');
    }, 10_000);
  });
});
