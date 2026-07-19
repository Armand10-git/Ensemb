/**
 * Tests d'intégration — PATCH /api/v1/organizations/branding
 *                         GET  /api/v1/public/organizations/by-subdomain/:subdomain
 *
 * Requiert uniquement Postgres. Redis et RealtimeGateway sont mockés.
 * Exclus du job test:unit en CI (pattern *.e2e.spec.ts).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { PrismaModule } from '../src/common/prisma.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { OrganizationsModule } from '../src/modules/organizations/organizations.module';
import { PublicOrganizationsController } from '../src/tenancy/public-organizations.controller';
import { TenancyService } from '../src/tenancy/tenancy.service';
import { RedisService } from '../src/common/redis.service';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { PrismaService } from '../src/common/prisma.service';

const PREFIX = `t05-test-${Date.now()}`;
const TEST_JWT_SECRET = 'test-jwt-secret-t05-branding';

/** Crée un tenant complet avec un user admin ayant la permission organization.branding.edit */
async function createTenant(
  prisma: PrismaService,
  subdomain: string,
): Promise<{ orgId: string; userId: string }> {
  const org = await prisma.organization.create({
    data: { name: `Org ${subdomain}`, subdomain },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      firstname: 'Admin',
      lastname: 'Test',
      email: `admin@${subdomain}.test`,
      username: `admin-${subdomain}`,
      password: 'hashed',
    },
    select: { id: true },
  });

  const brandingPerm = await prisma.permission.upsert({
    where: { name: 'organization.branding.edit' },
    update: {},
    create: { name: 'organization.branding.edit', label: 'Modifier le branding (logo/couleurs)' },
    select: { id: true },
  });

  const role = await prisma.role.create({
    data: { organizationId: org.id, name: 'admin-branding', label: 'Admin branding' },
    select: { id: true },
  });

  await prisma.permissionOnRole.create({
    data: { roleId: role.id, permissionId: brandingPerm.id },
  });

  await prisma.roleOnUser.create({
    data: { userId: user.id, roleId: role.id },
  });

  return { orgId: org.id, userId: user.id };
}

describe('OrganizationsController (e2e) — branding', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let jwtSecret: string;

  let tenant1: { orgId: string; userId: string };
  let tenant2: { orgId: string; userId: string };

  // Mock Redis : cache miss systématique — TenancyService tombera sur Prisma
  const mockRedis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };

  const mockEmit = jest.fn();
  const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
  const mockRealtimeGateway = { server: { to: mockTo } };

  beforeAll(async () => {
    // Fournit JWT_SECRET avant la compilation du module pour JwtStrategy
    process.env['JWT_SECRET'] = TEST_JWT_SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
        PassportModule,
        JwtModule.register({}),
        PrismaModule,
        AuditModule,
        OrganizationsModule,
      ],
      controllers: [PublicOrganizationsController],
      providers: [
        TenancyService,
        JwtStrategy,
        { provide: RedisService, useValue: mockRedis },
      ],
    })
      .overrideProvider(RealtimeGateway)
      .useValue(mockRealtimeGateway)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwtService = moduleRef.get(JwtService);
    jwtSecret = TEST_JWT_SECRET;

    tenant1 = await createTenant(prisma, `${PREFIX}-t1`);
    tenant2 = await createTenant(prisma, `${PREFIX}-t2`);
  }, 30_000);

  afterAll(async () => {
    const orgs = await prisma.organization.findMany({
      where: { subdomain: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = orgs.map((o) => o.id);

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
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  // ─── PATCH /api/v1/organizations/branding ──────────────────────────────────

  it('PATCH sans token → 401', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/organizations/branding')
      .send({ primaryColor: '#3B82F6' })
      .expect(401);
  });

  it('PATCH avec token valide sans permission organization.branding.edit → 403', async () => {
    const orgNoPerm = await prisma.organization.create({
      data: { name: `Org NoPerm ${PREFIX}`, subdomain: `${PREFIX}-noperm` },
      select: { id: true },
    });
    const userNoPerm = await prisma.user.create({
      data: {
        organizationId: orgNoPerm.id,
        firstname: 'No',
        lastname: 'Perm',
        email: `noperm@${PREFIX}.test`,
        username: `noperm-${PREFIX}`,
        password: 'hashed',
      },
      select: { id: true },
    });

    const token = makeToken(userNoPerm.id, orgNoPerm.id);
    await request(app.getHttpServer())
      .patch('/api/v1/organizations/branding')
      .set('Authorization', `Bearer ${token}`)
      .send({ primaryColor: '#3B82F6' })
      .expect(403);
  });

  it('PATCH avec token + permission + body valide → 200 avec branding', async () => {
    const token = makeToken(tenant1.userId, tenant1.orgId);
    const res = await request(app.getHttpServer())
      .patch('/api/v1/organizations/branding')
      .set('Authorization', `Bearer ${token}`)
      .send({ logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#3B82F6' })
      .expect(200);

    expect(res.body).toEqual({
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#3B82F6',
    });
  });

  it('PATCH body vide → 422', async () => {
    const token = makeToken(tenant1.userId, tenant1.orgId);
    await request(app.getHttpServer())
      .patch('/api/v1/organizations/branding')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422);
  });

  it('PATCH primaryColor invalide → 422', async () => {
    const token = makeToken(tenant1.userId, tenant1.orgId);
    await request(app.getHttpServer())
      .patch('/api/v1/organizations/branding')
      .set('Authorization', `Bearer ${token}`)
      .send({ primaryColor: 'rouge' })
      .expect(422);
  });

  // ─── GET /api/v1/public/organizations/by-subdomain/:subdomain ──────────────

  it('GET by-subdomain retourne logoUrl et primaryColor après mise à jour', async () => {
    // Applique le branding directement en base pour ne pas dépendre du test PATCH ci-dessus
    await prisma.organization.update({
      where: { id: tenant1.orgId },
      data: { logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#3B82F6' },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/public/organizations/by-subdomain/${PREFIX}-t1`)
      .expect(200);

    expect(res.body).toMatchObject({
      organizationId: tenant1.orgId,
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#3B82F6',
    });
  });

  it('isolation : le branding de tenant1 n\'affecte pas tenant2', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/public/organizations/by-subdomain/${PREFIX}-t2`)
      .expect(200);

    expect(res.body.organizationId).toBe(tenant2.orgId);
    expect(res.body.logoUrl).toBeNull();
    expect(res.body.primaryColor).toBeNull();
  });

  it('GET sous-domaine inexistant → 404', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/public/organizations/by-subdomain/inexistant-${Date.now()}`)
      .expect(404);
  });
});
