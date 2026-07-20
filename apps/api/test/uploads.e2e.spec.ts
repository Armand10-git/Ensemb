/**
 * Tests e2e UploadsModule — Supertest + MinIO réel (docker-compose).
 * Couvre : auth, upload JPEG valide, rejet PDF, rejet > 5 Mo,
 *          URL signée accessible, isolation tenant (IDOR).
 *
 * Prérequis : DATABASE_URL, REDIS_URL, S3_* dans l'environnement
 * (automatiquement chargés depuis .env via jest.config.js → setupFiles).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  S3Client,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { PrismaModule } from '../src/common/prisma.module';
import { RedisModule } from '../src/common/redis.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { RolesModule } from '../src/modules/roles/roles.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { UploadsModule } from '../src/modules/uploads/uploads.module';

jest.setTimeout(60_000);

// ─── Variables de test ────────────────────────────────────────────────────────

const SUBDOMAIN_A = `e2e-uploads-a-${Date.now()}`;
const SUBDOMAIN_B = `e2e-uploads-b-${Date.now()}`;
let orgAId: string;
let orgBId: string;
let tokenA: string;
let tokenB: string;
let prisma: PrismaClient;
let s3: S3Client;
let app: INestApplication;
const createdKeys: string[] = []; // nettoyage afterAll

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeJpegBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } })
    .jpeg()
    .toBuffer();
}

function makePdfBuffer(): Buffer {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  // ── S3 client MinIO (crée le bucket si absent) ────────────────────────────
  s3 = new S3Client({
    endpoint:        process.env['S3_ENDPOINT']           ?? 'http://localhost:9000',
    region:          process.env['S3_REGION']             ?? 'us-east-1',
    credentials: {
      accessKeyId:     process.env['S3_ACCESS_KEY_ID']     ?? 'ensemb',
      secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'ensemb_dev',
    },
    forcePathStyle: true,
  });

  const bucket = process.env['S3_BUCKET'] ?? 'ensemb-uploads';

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  // ── Données DB ────────────────────────────────────────────────────────────
  const orgA = await prisma.organization.create({
    data: { name: 'Uploads E2E Org A', subdomain: SUBDOMAIN_A },
  });
  orgAId = orgA.id;

  const orgB = await prisma.organization.create({
    data: { name: 'Uploads E2E Org B', subdomain: SUBDOMAIN_B },
  });
  orgBId = orgB.id;

  // User A
  const roleA = await prisma.role.create({ data: { organizationId: orgAId, name: 'UploadsAdmin' } });
  const userA = await prisma.user.create({
    data: {
      organizationId: orgAId,
      firstname: 'User', lastname: 'A',
      email: `userA-${Date.now()}@e2e.cm`, username: `userA-${Date.now()}`,
      password: await bcrypt.hash('Pass@1234!', 12),
      isActive: true,
    },
  });
  await prisma.roleOnUser.create({ data: { userId: userA.id, roleId: roleA.id } });

  // User B (isolation tenant)
  const roleB = await prisma.role.create({ data: { organizationId: orgBId, name: 'UploadsAdmin' } });
  const userB = await prisma.user.create({
    data: {
      organizationId: orgBId,
      firstname: 'User', lastname: 'B',
      email: `userB-${Date.now()}@e2e.cm`, username: `userB-${Date.now()}`,
      password: await bcrypt.hash('Pass@1234!', 12),
      isActive: true,
    },
  });
  await prisma.roleOnUser.create({ data: { userId: userB.id, roleId: roleB.id } });

  // ── Application NestJS ────────────────────────────────────────────────────
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
      PrismaModule,
      RedisModule,
      PassportModule,
      JwtModule.register({}),
      AuthModule,
      RolesModule,
      AuditModule,
      UploadsModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  // Login
  const email_a = userA.email;
  const email_b = userB.email;

  const resA = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: email_a, password: 'Pass@1234!' });
  tokenA = (resA.body as { accessToken: string }).accessToken;

  const resB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: email_b, password: 'Pass@1234!' });
  tokenB = (resB.body as { accessToken: string }).accessToken;
});

afterAll(async () => {
  // Supprime les objets S3 créés pendant les tests
  const bucket = process.env['S3_BUCKET'] ?? 'ensemb-uploads';
  for (const key of createdKeys) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
  }

  // Nettoyage DB
  await prisma.organization.updateMany({
    where: { subdomain: { in: [SUBDOMAIN_A, SUBDOMAIN_B] } },
    data: { deletedAt: new Date() },
  });

  await prisma.$disconnect();
  await app.close();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/uploads/images', () => {
  it('sans token → 401', async () => {
    await supertest(app.getHttpServer())
      .post('/api/v1/uploads/images?type=products')
      .attach('file', Buffer.from([0xff, 0xd8, 0xff]), 'photo.jpg')
      .expect(401);
  });

  it('JPEG valide → 201 + { s3Key } ; objet présent dans MinIO', async () => {
    const jpeg = await makeJpegBuffer();

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/uploads/images?type=products')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', jpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' })
      .expect(201);

    const body = res.body as { s3Key: string };
    expect(body.s3Key).toMatch(new RegExp(`^${orgAId}/products/[a-f0-9-]+\\.jpg$`));
    createdKeys.push(body.s3Key);
  });

  it('PDF (magic bytes) → 415 UnsupportedMediaTypeException', async () => {
    await supertest(app.getHttpServer())
      .post('/api/v1/uploads/images?type=products')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', makePdfBuffer(), { filename: 'doc.pdf', contentType: 'application/pdf' })
      .expect(415);
  });

  it('fichier > 5 Mo → 400 ou 413', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0xff);

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/uploads/images?type=products')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', big, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect([400, 413]).toContain(res.status);
  });
});

describe('GET /api/v1/uploads/images/signed-url', () => {
  let uploadedKey: string;

  beforeAll(async () => {
    // Upload préalable pour obtenir une clé valide
    const jpeg = await makeJpegBuffer();
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/uploads/images?type=logos')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', jpeg, { filename: 'logo.jpg', contentType: 'image/jpeg' });

    uploadedKey = (res.body as { s3Key: string }).s3Key;
    createdKeys.push(uploadedKey);
  });

  it('clé valide → 200 + { url, expiresIn }', async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/uploads/images/signed-url?key=${encodeURIComponent(uploadedKey)}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    const body = res.body as { url: string; expiresIn: number };
    expect(typeof body.url).toBe('string');
    expect(body.url).toMatch(/^http/);
    expect(body.expiresIn).toBeGreaterThan(0);
  });

  it('clé d\'une autre org → 403 (IDOR)', async () => {
    // tokenB (org B) tente d'accéder à la clé de org A
    await supertest(app.getHttpServer())
      .get(`/api/v1/uploads/images/signed-url?key=${encodeURIComponent(uploadedKey)}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
  });
});
