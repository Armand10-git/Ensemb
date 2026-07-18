import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../../../common/prisma.module';
import { RedisModule } from '../../../common/redis.module';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { JwtStrategy } from '../strategies/jwt.strategy';
import { JwtRefreshStrategy } from '../strategies/jwt-refresh.strategy';

/**
 * Tests d'integration AuthModule — Supertest contre Postgres + Redis locaux.
 * Requiert DATABASE_URL et REDIS_HOST/PORT dans l'environnement.
 */

jest.setTimeout(30_000);

const TEST_ORG_SUBDOMAIN = `test-auth-e2e-${Date.now()}`;
let orgId: string;
let prisma: PrismaClient;
let app: INestApplication;

beforeAll(async () => {
  prisma = new PrismaClient();

  const org = await prisma.organization.create({
    data: { name: 'Auth E2E Org', subdomain: TEST_ORG_SUBDOMAIN },
  });
  orgId = org.id;

  await prisma.user.create({
    data: {
      organizationId: orgId,
      firstname: 'Test',
      lastname: 'Admin',
      email: 'auth-test@e2e.cm',
      username: 'auth-test',
      password: await bcrypt.hash('TestPass!1', 12),
      isActive: true,
    },
  });

  await prisma.user.create({
    data: {
      organizationId: orgId,
      firstname: 'Disabled',
      lastname: 'User',
      email: 'disabled@e2e.cm',
      username: 'disabled',
      password: await bcrypt.hash('TestPass!1', 12),
      isActive: false,
    },
  });

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
      PrismaModule,
      RedisModule,
      PassportModule,
      JwtModule.register({}),
    ],
    controllers: [AuthController],
    providers: [AuthService, JwtStrategy, JwtRefreshStrategy],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
});

afterAll(async () => {
  await app.close();
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe('POST /api/v1/auth/login', () => {
  it('200 + tokens + permissions pour des identifiants valides', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ email: 'auth-test@e2e.cm', password: 'TestPass!1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });

  it('401 pour un mot de passe incorrect', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ email: 'auth-test@e2e.cm', password: 'WrongPass!' });

    expect(res.status).toBe(401);
  });

  it('401 pour un email inexistant — reponse neutre', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ email: 'ghost@e2e.cm', password: 'TestPass!1' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Identifiants invalides.');
  });

  it('401 pour un compte desactive avec message explicite', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ email: 'disabled@e2e.cm', password: 'TestPass!1' });

    expect(res.status).toBe(401);
    expect(typeof res.body.message).toBe('string');
  });

  it('422 si X-Organization-Id manquant', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'auth-test@e2e.cm', password: 'TestPass!1' });

    expect(res.status).toBe(422);
  });

  it('422 si body invalide (email manquant)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ password: 'TestPass!1' });

    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/auth/logout', () => {
  let accessToken: string;
  let refreshToken: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ email: 'auth-test@e2e.cm', password: 'TestPass!1' });

    accessToken = res.body.accessToken as string;
    refreshToken = res.body.refreshToken as string;
  });

  it('204 et revoque le refresh token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });

    expect(res.status).toBe(204);
  });

  it('401 si pas de Bearer token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken });

    expect(res.status).toBe(401);
  });
});
