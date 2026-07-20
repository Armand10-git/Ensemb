/**
 * Tests e2e ProductModule — Supertest contre Postgres local.
 * StorageService mocké (pas de MinIO requis).
 *
 * Couvre :
 *  - CRUD complet produit sans variantes
 *  - CRUD produit avec variantes (create + delete variant)
 *  - Upload image → Product.image mis à jour avec clé S3
 *  - Isolation multi-tenant : produits d'un tenant non visibles par un autre
 *  - Doublon de code même org → 409 ; deux orgs différentes → 201
 *  - IDOR : categoryId d'une autre org → 403
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import sharp from 'sharp';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaModule } from '../src/common/prisma.module';
import { EncryptionModule } from '../src/common/encryption.module';
import { RedisModule } from '../src/common/redis.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { CatalogModule } from '../src/modules/catalog/catalog.module';
import { UploadsModule } from '../src/modules/uploads/uploads.module';
import { StorageService } from '../src/modules/uploads/storage.service';

jest.setTimeout(30_000);

// ─── Mock StorageService (pas de MinIO) ──────────────────────────────────────

const SIGNED = 'https://mocked.s3/signed?key=img.jpg';

const mockStorage = {
  upload:       jest.fn().mockResolvedValue(undefined),
  getSignedUrl: jest.fn().mockResolvedValue(SIGNED),
  delete:       jest.fn().mockResolvedValue(undefined),
};

// ─── Variables de test ───────────────────────────────────────────────────────

const SUFFIX = Date.now();
const ORG_A_SUB = `e2e-prod-a-${SUFFIX}`;
const ORG_B_SUB = `e2e-prod-b-${SUFFIX}`;

let app: INestApplication;
let prisma: PrismaClient;
let orgAId: string, orgBId: string;
let tokenA: string, tokenB: string;
let catAId: string, catBId: string;

const PRODUCT_PERMS = [
  'products.view', 'products.create', 'products.edit', 'products.delete',
  'categories.view', 'categories.create',
  'brands.view',
];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  const orgA = await prisma.organization.create({ data: { name: 'E2E Prod A', subdomain: ORG_A_SUB } });
  const orgB = await prisma.organization.create({ data: { name: 'E2E Prod B', subdomain: ORG_B_SUB } });
  orgAId = orgA.id;
  orgBId = orgB.id;

  // Catégories pour chaque org
  catAId = (await prisma.category.create({ data: { organizationId: orgAId, code: 'TST', name: `Cat-A-${SUFFIX}` } })).id;
  catBId = (await prisma.category.create({ data: { organizationId: orgBId, code: 'TST', name: `Cat-B-${SUFFIX}` } })).id;

  // Permissions
  for (const name of PRODUCT_PERMS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name, label: name } });
  }
  const perms = await prisma.permission.findMany({ where: { name: { in: PRODUCT_PERMS } }, select: { id: true } });

  async function setupOrgUser(orgId: string, email: string) {
    const role = await prisma.role.create({ data: { organizationId: orgId, name: 'Admin' } });
    for (const p of perms) {
      await prisma.permissionOnRole.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId, firstname: 'Test', lastname: 'User',
        email, username: email,
        password: await bcrypt.hash('TestPass!1', 12),
        isActive: true,
      },
    });
    await prisma.roleOnUser.create({ data: { userId: user.id, roleId: role.id } });
  }

  await setupOrgUser(orgAId, `user-pa-${SUFFIX}@e2e.cm`);
  await setupOrgUser(orgBId, `user-pb-${SUFFIX}@e2e.cm`);

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
      PassportModule,
      JwtModule.register({}),
      PrismaModule,
      EncryptionModule,
      RedisModule,
      AuditModule,
      AuthModule,
      UploadsModule,
      CatalogModule,
    ],
  })
    .overrideProvider(StorageService)
    .useValue(mockStorage)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  const loginA = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgAId)
    .send({ email: `user-pa-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenA = loginA.body.accessToken as string;

  const loginB = await supertest(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Organization-Id', orgBId)
    .send({ email: `user-pb-${SUFFIX}@e2e.cm`, password: 'TestPass!1' });
  tokenB = loginB.body.accessToken as string;
});

afterAll(async () => {
  await app?.close();

  await prisma.productVariant.deleteMany({ where: { product: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.product.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.brand.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.unit.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: [orgAId, orgBId] } } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });

  await prisma.$disconnect();
});

// ─── Helpers produit ──────────────────────────────────────────────────────────

function baseProduct(suffix = SUFFIX, catId = catAId) {
  return {
    code: `P${suffix % 10000}`,
    name: `Produit-${suffix}`,
    cost: '1000',
    price: '1500',
    categoryId: catId,
    taxRate: '0.1925',
    taxMethod: 'percentage',
    stockAlert: 5,
    isVariant: false,
  };
}

// ─── POST /catalog/products ───────────────────────────────────────────────────

describe('POST /api/v1/catalog/products', () => {
  it('201 — crée un produit simple pour le tenant A', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(baseProduct());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: `P${SUFFIX % 10000}`, name: `Produit-${SUFFIX}` });
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('imageUrl', null);
  });

  it('409 — doublon de code dans la même org', async () => {
    const code = `DC${SUFFIX % 1000}`;
    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code, name: `Dup-1-${SUFFIX}` });

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code, name: `Dup-2-${SUFFIX}` });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/code/i);
  });

  it('201 — même code, deux orgs différentes → OK', async () => {
    const code = `SH${SUFFIX % 1000}`;
    await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code, name: `Share-A-${SUFFIX}` });

    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ ...baseProduct(SUFFIX, catBId), code, name: `Share-B-${SUFFIX}` });

    expect(res.status).toBe(201);
  });

  it('403 — categoryId appartenant à une autre org → rejeté', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code: `IDOR${SUFFIX % 1000}`, categoryId: catBId });

    expect(res.status).toBe(403);
  });

  it('422 — champs obligatoires manquants', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Sans code', cost: '100', price: '200' });

    expect(res.status).toBe(422);
  });

  it('401 — sans token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .send(baseProduct());
    expect(res.status).toBe(401);
  });
});

// ─── GET /catalog/products ────────────────────────────────────────────────────

describe('GET /api/v1/catalog/products', () => {
  it("200 — retourne uniquement les produits du tenant A", async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    const ids: string[] = (res.body.data as { id: string }[]).map((p) => p.id);
    // aucun produit de l'org B dans la liste A
    const orgBProd = await prisma.product.findMany({ where: { organizationId: orgBId }, select: { id: true } });
    for (const { id } of orgBProd) expect(ids).not.toContain(id);
  });

  it("200 — imageUrl présente si image S3 non nulle", async () => {
    const prodRes = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code: `IMG${SUFFIX % 1000}`, name: `WithImg-${SUFFIX}` });
    const prodId = (prodRes.body as { id: string }).id;

    const jpegBuf = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    await supertest(app.getHttpServer())
      .post(`/api/v1/catalog/products/${prodId}/image`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', jpegBuf, { filename: 'img.jpg', contentType: 'image/jpeg' });

    const list = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`);

    const found = (list.body.data as { id: string; imageUrl: string | null }[]).find((p) => p.id === prodId);
    expect(found).toBeDefined();
    expect(found?.imageUrl).toBe(SIGNED);
  });
});

// ─── GET /catalog/products/:id ────────────────────────────────────────────────

describe('GET /api/v1/catalog/products/:id', () => {
  let prodId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code: `DT${SUFFIX % 1000}`, name: `Detail-${SUFFIX}` });
    prodId = (res.body as { id: string }).id;
  });

  it("200 — retourne le produit du tenant", async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/catalog/products/${prodId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(prodId);
  });

  it("403 ou 404 — tenant B ne peut pas voir le produit du tenant A", async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/catalog/products/${prodId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect([403, 404]).toContain(res.status);
  });
});

// ─── PATCH /catalog/products/:id ─────────────────────────────────────────────

describe('PATCH /api/v1/catalog/products/:id', () => {
  let prodId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code: `UP${SUFFIX % 1000}`, name: `Update-${SUFFIX}` });
    prodId = (res.body as { id: string }).id;
  });

  it("200 — met à jour le nom", async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/catalog/products/${prodId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Updated-${SUFFIX}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Updated-${SUFFIX}`);
  });

  it("403 ou 404 — tenant B ne peut pas modifier", async () => {
    const res = await supertest(app.getHttpServer())
      .patch(`/api/v1/catalog/products/${prodId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hack' });
    expect([403, 404]).toContain(res.status);
  });
});

// ─── POST /catalog/products/:id/image ────────────────────────────────────────

describe('POST /api/v1/catalog/products/:id/image', () => {
  let prodId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code: `IM${SUFFIX % 1000}`, name: `Imageable-${SUFFIX}` });
    prodId = (res.body as { id: string }).id;
  });

  it("200 — upload JPEG valide → clé S3 sauvegardée, imageUrl retournée", async () => {
    const jpegBuf = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#3366ff' },
    }).jpeg().toBuffer();

    const res = await supertest(app.getHttpServer())
      .post(`/api/v1/catalog/products/${prodId}/image`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', jpegBuf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('imageUrl');
    expect(typeof res.body.imageUrl).toBe('string');

    // Vérifier que la clé S3 est sauvegardée en DB
    const prod = await prisma.product.findUnique({ where: { id: prodId }, select: { image: true } });
    expect(prod?.image).toBeTruthy();
    expect(typeof prod?.image).toBe('string');
    expect(prod?.image).not.toBe('');
    uploadedKey = prod?.image ?? '';
  });
});

// ─── Variantes ────────────────────────────────────────────────────────────────

describe('Variantes — POST + DELETE /catalog/products/:id/variants', () => {
  let prodId: string;
  let variantId: string;

  beforeAll(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        ...baseProduct(), code: `VA${SUFFIX % 1000}`, name: `Variante-${SUFFIX}`,
        isVariant: true,
        variants: [{ name: 'Rouge / S' }],
      });
    prodId = (res.body as { id: string }).id;
  });

  it("201 — ajoute une variante au produit", async () => {
    const res = await supertest(app.getHttpServer())
      .post(`/api/v1/catalog/products/${prodId}/variants`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Bleu / M' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    variantId = (res.body as { id: string }).id;
  });

  it("GET produit inclut la variante créée", async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/v1/catalog/products/${prodId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    const variants = res.body.variants as { id: string; name: string }[];
    expect(variants.some((v) => v.id === variantId)).toBe(true);
  });

  it("204 — suppression de variante (soft-delete)", async () => {
    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/catalog/products/${prodId}/variants/${variantId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(204);

    // La variante n'apparaît plus dans la liste
    const prod = await supertest(app.getHttpServer())
      .get(`/api/v1/catalog/products/${prodId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    const ids = (prod.body.variants as { id: string }[]).map((v) => v.id);
    expect(ids).not.toContain(variantId);
  });
});

// ─── Soft-delete ──────────────────────────────────────────────────────────────

describe('DELETE /api/v1/catalog/products/:id', () => {
  it("204 — soft-delete du produit", async () => {
    const created = await supertest(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...baseProduct(), code: `DEL${SUFFIX % 1000}`, name: `ToDelete-${SUFFIX}` });
    const id = (created.body as { id: string }).id;

    const res = await supertest(app.getHttpServer())
      .delete(`/api/v1/catalog/products/${id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(204);

    // Absent de la liste
    const list = await supertest(app.getHttpServer())
      .get('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${tokenA}`);
    const ids = (list.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(id);

    // Toujours en DB (soft delete)
    const row = await prisma.product.findUnique({ where: { id }, select: { deletedAt: true } });
    expect(row?.deletedAt).toBeTruthy();
  });
});
