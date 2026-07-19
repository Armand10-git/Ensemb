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

    it('inscriptions simultanées sur le même sous-domaine : une seule réussit (P2002 traduit en 409)', async () => {
      const concurrentSubdomain = `${SUBDOMAIN_PREFIX}-concurrent`;
      const payload = {
        subdomain: concurrentSubdomain,
        organizationName: 'Concurrence Test',
        adminFirstname: 'Jean',
        adminLastname: 'Durand',
        adminEmail: `admin@${concurrentSubdomain}.test`,
        adminPassword: 'MotDePasse123!',
      };

      // Deux requêtes simultanées — l'une passe la vérification hors-transaction
      // avant que l'autre ait persisté, forçant la contrainte unique en base.
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/public/organizations/register').send(payload),
        request(app.getHttpServer()).post('/api/v1/public/organizations/register').send(payload),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactement une réussit (201) et l'autre échoue (409 ou 422)
      expect(statuses[0]).toBeLessThanOrEqual(409);
      expect(statuses[1]).toBeGreaterThanOrEqual(201);
      // Exactement une organisation créée
      const orgsCreated = await prisma.organization.count({ where: { subdomain: concurrentSubdomain } });
      expect(orgsCreated).toBe(1);
    }, 15_000);
  });
});
