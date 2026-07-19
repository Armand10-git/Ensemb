/**
 * Tests d'intégration — POST /api/v1/public/organizations/register
 * Requiert uniquement Postgres (pas Redis). Module allégé sans RealtimeModule/RedisModule.
 * Exclus du job test:unit en CI (pattern *.e2e.spec.ts).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaModule } from '../src/common/prisma.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { RegistrationModule } from '../src/modules/registration/registration.module';
import { PrismaService } from '../src/common/prisma.service';

const SUBDOMAIN_PREFIX = `t04-test-${Date.now()}`;

describe('RegistrationController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
        PrismaModule,
        AuditModule,
        RegistrationModule,
      ],
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = module.get(PrismaService);
  }, 30_000);

  afterAll(async () => {
    // Nettoyage : respecter les FK (User → Org, Role → Org)
    const orgs = await prisma.organization.findMany({
      where: { subdomain: { startsWith: 't04-test-' } },
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

  describe('GET /api/v1/public/organizations/check-subdomain/:subdomain', () => {
    it('retourne { available: true } pour un sous-domaine libre', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/organizations/check-subdomain/${SUBDOMAIN_PREFIX}-free`)
        .expect(200);

      expect(res.body).toEqual({ available: true });
    });

    it('retourne { available: false } pour un sous-domaine reserve (www)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/organizations/check-subdomain/www')
        .expect(200);

      expect(res.body).toEqual({ available: false });
    });
  });

  describe('POST /api/v1/public/organizations/register', () => {
    const subdomain = `${SUBDOMAIN_PREFIX}-reg`;

    it('cree organisation + utilisateur admin + role administrateur en transaction', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/public/organizations/register')
        .send({
          subdomain,
          organizationName: 'Boutique T04',
          adminFirstname: 'Jean',
          adminLastname: 'Durand',
          adminEmail: `admin@${subdomain}.test`,
          adminPassword: 'MotDePasse123!',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        organizationId: expect.any(String),
        subdomain,
        adminUserId: expect.any(String),
      });

      // Vérifier la persistance en base
      const org = await prisma.organization.findUnique({
        where: { subdomain },
        include: {
          users: true,
          roles: { include: { permissions: true } },
        },
      });

      expect(org).not.toBeNull();
      expect(org!.status).toBe('TRIALING');
      expect(org!.trialEndsAt).not.toBeNull();
      expect(org!.users).toHaveLength(1);
      expect(org!.roles).toHaveLength(1);
      const adminRole = org!.roles[0];
      expect(adminRole).toBeDefined();
      expect(adminRole!.name).toBe('administrateur');
      // Le rôle administrateur reçoit exactement toutes les permissions du catalogue global
      const catalogueCount = await prisma.permission.count();
      expect(adminRole!.permissions.length).toBe(catalogueCount);
    }, 15_000);

    it('GET check-subdomain retourne { available: false } apres inscription', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/organizations/check-subdomain/${subdomain}`)
        .expect(200);

      expect(res.body).toEqual({ available: false });
    });

    it('renvoie 422 pour un mot de passe trop court', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/public/organizations/register')
        .send({
          subdomain: `${SUBDOMAIN_PREFIX}-short`,
          organizationName: 'Test',
          adminFirstname: 'Jean',
          adminLastname: 'Durand',
          adminEmail: 'jean@test.com',
          adminPassword: '1234567', // 7 chars
        })
        .expect(422);
    });

    it('renvoie 422 pour un sous-domaine invalide (majuscules)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/public/organizations/register')
        .send({
          subdomain: 'Boutique',
          organizationName: 'Test',
          adminFirstname: 'Jean',
          adminLastname: 'Durand',
          adminEmail: 'jean@test.com',
          adminPassword: 'MotDePasse123!',
        })
        .expect(422);
    });

    it('renvoie 409 pour un sous-domaine deja pris (message neutre)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/public/organizations/register')
        .send({
          subdomain,
          organizationName: 'Doublon',
          adminFirstname: 'Marie',
          adminLastname: 'Dupont',
          adminEmail: 'marie@autre.test',
          adminPassword: 'MotDePasse456!',
        })
        .expect(409);

      // Le message ne doit pas révéler qu'une organisation existe déjà
      const message = res.body.message as string;
      expect(message).not.toContain('existe');
      expect(message).toContain('disponible');
    });

    it('rollback : aucune org partielle pour sous-domaine reserve (rejet zod avant transaction)', async () => {
      const resBefore = await prisma.organization.findMany({
        where: { subdomain: { startsWith: SUBDOMAIN_PREFIX } },
      });
      const countBefore = resBefore.length;

      await request(app.getHttpServer())
        .post('/api/v1/public/organizations/register')
        .send({
          subdomain: 'api', // sous-domaine réservé → 422 avant toute transaction DB
          organizationName: 'Test',
          adminFirstname: 'Jean',
          adminLastname: 'Durand',
          adminEmail: 'jean@test.com',
          adminPassword: 'MotDePasse123!',
        })
        .expect(422);

      const resAfter = await prisma.organization.findMany({
        where: { subdomain: { startsWith: SUBDOMAIN_PREFIX } },
      });
      expect(resAfter.length).toBe(countBefore);
    });
  });
});
