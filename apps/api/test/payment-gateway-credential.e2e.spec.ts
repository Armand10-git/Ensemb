/**
 * Tests d'intégration — endpoint HTTP de configuration de l'agrégateur de paiement (S31,
 * §17 point S/2 — secrets chiffrés jamais exposés).
 *
 * PaymentGatewayCredentialService est déjà couvert au niveau service (test/
 * payment-gateway-credential.service.spec.ts, mocks Prisma) : ce fichier vérifie le contrat au
 * niveau HTTP réel (supertest, vraie base) — PUT /api/v1/organizations/settings/payment-gateway
 * ne doit JAMAIS renvoyer apiKeyCipher/webhookSecretCipher (ni apiKey/webhookSecret en clair)
 * dans le corps de la réponse, et la valeur persistée en base n'est jamais le secret en clair
 * (même patron anti-fuite que test/encryption.e2e.spec.ts).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { getTestPrisma } from './helpers/prisma';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { RedisModule } from '../src/common/redis.module';
import { DocumentCounterModule } from '../src/common/document-counter.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { PaymentGatewayModule } from '../src/modules/payment-gateway/payment-gateway.module';

jest.setTimeout(40_000);

const SUFFIX = Date.now();
const ORG_SUBDOMAIN = `e2e-pg-cred-${SUFFIX}`;

const API_KEY = 'sk_live_super_secret_api_key';
const WEBHOOK_SECRET = 'whsec_super_secret_webhook_key';

let app: INestApplication;
const prisma = getTestPrisma();
let orgId: string;
let token: string;
let tokenNoPerm: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'E2E PG Credential', subdomain: ORG_SUBDOMAIN } });
  orgId = org.id;

  const permName = 'organization.settings.edit';
  await prisma.permission.upsert({ where: { name: permName }, update: {}, create: { name: permName, label: permName } });
  const perm = await prisma.permission.findUniqueOrThrow({ where: { name: permName } });

  const role = await prisma.role.create({ data: { organizationId: orgId, name: 'Admin' } });
  await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: perm.id } });
  const user = await prisma.user.create({
    data: {
      organizationId: orgId,
      firstname: 'Test',
      lastname: 'PgCred',
      email: `pg-cred-${SUFFIX}@e2e.cm`,
      username: `pg-cred-${SUFFIX}@e2e.cm`,
      password: await bcrypt.hash('TestPass!1', 12),
      isActive: true,
    },
  });
  await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });

  // Utilisateur SANS la permission organization.settings.edit — pour le test 403.
  const roleNoPerm = await prisma.role.create({ data: { organizationId: orgId, name: 'Vendeur' } });
  const userNoPerm = await prisma.user.create({
    data: {
      organizationId: orgId,
      firstname: 'Test',
      lastname: 'PgCredNoPerm',
      email: `pg-cred-noperm-${SUFFIX}@e2e.cm`,
      username: `pg-cred-noperm-${SUFFIX}@e2e.cm`,
      password: await bcrypt.hash('TestPass!1', 12),
      isActive: true,
    },
  });
  await prisma.roleOnUser.create({ data: { userId: userNoPerm.id, roleId: roleNoPerm.id } });

  const moduleRef: TestingModule = await Test.createTestingModule({
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
      RedisModule,
      DocumentCounterModule,
      AuditModule,
      AuthModule,
      TenancyModule,
      PaymentGatewayModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  async function login(email: string): Promise<string> {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Organization-Id', orgId)
      .send({ email, password: 'TestPass!1' });
    return res.body.accessToken as string;
  }

  token = await login(`pg-cred-${SUFFIX}@e2e.cm`);
  tokenNoPerm = await login(`pg-cred-noperm-${SUFFIX}@e2e.cm`);
});

afterAll(async () => {
  await app?.close();
  await prisma.paymentGatewayCredential.deleteMany({ where: { organizationId: orgId } });
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: orgId } } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: orgId } } });
  await prisma.role.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

describe('PUT /api/v1/organizations/settings/payment-gateway', () => {
  it('200 — configure les identifiants, réponse HTTP sans apiKeyCipher/webhookSecretCipher/apiKey/webhookSecret', async () => {
    const res = await supertest(app.getHttpServer())
      .put('/api/v1/organizations/settings/payment-gateway')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', orgId)
      .send({
        apiKey: API_KEY,
        merchantId: 'MERCHANT-E2E',
        webhookSecret: WEBHOOK_SECRET,
        isActive: true,
      });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;

    // Champs publics attendus
    expect(typeof body['id']).toBe('string');
    expect(body['organizationId']).toBe(orgId);
    expect(body['merchantId']).toBe('MERCHANT-E2E');
    expect(body['isActive']).toBe(true);

    // Anti-fuite HTTP — aucun secret, chiffré ou en clair, dans la réponse.
    expect(body).not.toHaveProperty('apiKeyCipher');
    expect(body).not.toHaveProperty('webhookSecretCipher');
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('webhookSecret');
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
  });

  it('401 — sans token', async () => {
    await supertest(app.getHttpServer())
      .put('/api/v1/organizations/settings/payment-gateway')
      .set('X-Organization-Id', orgId)
      .send({ apiKey: 'x', webhookSecret: 'y' })
      .expect(401);
  });

  it("403 — utilisateur sans la permission organization.settings.edit", async () => {
    await supertest(app.getHttpServer())
      .put('/api/v1/organizations/settings/payment-gateway')
      .set('Authorization', `Bearer ${tokenNoPerm}`)
      .set('X-Organization-Id', orgId)
      .send({ apiKey: 'x', webhookSecret: 'y' })
      .expect(403);
  });

  it('un SELECT brut sur payment_gateway_credentials ne contient les secrets en clair dans aucune colonne', async () => {
    const rows = await prisma.$queryRaw<{ apiKeyCipher: string; webhookSecretCipher: string }[]>`
      SELECT "apiKeyCipher", "webhookSecretCipher" FROM payment_gateway_credentials WHERE "organizationId" = ${orgId}::uuid
    `;

    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row.apiKeyCipher).not.toContain(API_KEY);
    expect(row.webhookSecretCipher).not.toContain(WEBHOOK_SECRET);

    // Format "hex:hex:hex" (iv:tag:ciphertext) — même format qu'EncryptionService ailleurs.
    for (const cipher of [row.apiKeyCipher, row.webhookSecretCipher]) {
      const parts = cipher.split(':');
      expect(parts).toHaveLength(3);
      parts.forEach((p) => expect(/^[0-9a-f]+$/i.test(p)).toBe(true));
    }
  });
});
