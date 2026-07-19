/**
 * Tests d'intégration — T09 BackupModule :
 *   - Authentification et contrôle d'accès (401, 403)
 *   - Création d'export, listing paginé
 *   - Téléchargement (ReadStream, Content-Type)
 *   - Isolation tenant : un org ne peut pas accéder aux exports d'un autre
 *   - Suppression (fichier physique + ligne BDD)
 *
 * Requiert Postgres. Redis/BullMQ mockés.
 */
import * as fs from 'fs';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { PrismaModule } from '../src/common/prisma.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { BackupModule } from '../src/modules/backup/backup.module';
import { BackupService } from '../src/modules/backup/backup.service';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { PrismaService } from '../src/common/prisma.service';

const PREFIX = `t09-test-${Date.now()}`;
const TEST_JWT_SECRET = 'test-jwt-secret-t09-backup';

describe('BackupModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let backupService: BackupService;

  // IDs d'organisation créés pour les tests
  let orgAId: string;
  let orgBId: string;
  let userAId: string;
  let userBId: string;

  const createdFilePaths: string[] = [];

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
        BackupModule,
      ],
      providers: [JwtStrategy],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwtService = moduleRef.get(JwtService);
    backupService = moduleRef.get(BackupService);

    // Créer deux organisations de test
    const orgA = await prisma.organization.create({
      data: { name: 'Org A T09', subdomain: `${PREFIX}-a` },
    });
    orgAId = orgA.id;

    const orgB = await prisma.organization.create({
      data: { name: 'Org B T09', subdomain: `${PREFIX}-b` },
    });
    orgBId = orgB.id;

    // Créer la permission backup.manage
    const perm = await prisma.permission.upsert({
      where: { name: 'backup.manage' },
      update: {},
      create: { name: 'backup.manage', label: 'Gérer les exports de données (T09)' },
    });

    // Rôle admin pour orgA avec backup.manage
    const roleA = await prisma.role.create({
      data: { organizationId: orgAId, name: `admin-${PREFIX}` },
    });
    await prisma.permissionOnRole.create({
      data: { roleId: roleA.id, permissionId: perm.id },
    });

    // Utilisateur orgA avec la permission
    const userA = await prisma.user.create({
      data: {
        organizationId: orgAId,
        firstname: 'Alice',
        lastname: 'A',
        email: `alice@${PREFIX}.test`,
        username: `alice-${PREFIX}`,
        password: 'hash',
      },
    });
    userAId = userA.id;
    await prisma.roleOnUser.create({ data: { userId: userAId, roleId: roleA.id } });

    // Utilisateur orgB (sans permission dans orgA — isolation)
    const userB = await prisma.user.create({
      data: {
        organizationId: orgBId,
        firstname: 'Bob',
        lastname: 'B',
        email: `bob@${PREFIX}.test`,
        username: `bob-${PREFIX}`,
        password: 'hash',
      },
    });
    userBId = userB.id;
  }, 30_000);

  afterAll(async () => {
    // Nettoyage fichiers physiques
    for (const p of createdFilePaths) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // Nettoyage BDD
    const orgs = await prisma.organization.findMany({
      where: { subdomain: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = orgs.map((o) => o.id);

    await prisma.backupExport.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.roleOnUser.deleteMany({ where: { user: { organizationId: { in: ids } } } });
    await prisma.user.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.permissionOnRole.deleteMany({ where: { role: { organizationId: { in: ids } } } });
    await prisma.role.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });

    await app.close();
  }, 15_000);

  function makeToken(userId: string, orgId: string): string {
    return jwtService.sign(
      { sub: userId, organizationId: orgId, email: `user@${orgId}.test` },
      { secret: TEST_JWT_SECRET, expiresIn: '1h' },
    );
  }

  // ─── Authentification ────────────────────────────────────────────────────────

  it('POST /api/v1/backup/exports sans token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backup/exports')
      .expect(401);
  });

  it('POST /api/v1/backup/exports avec token sans permission backup.manage → 403', async () => {
    // userB n'a aucun rôle avec backup.manage dans son org
    const tokenB = makeToken(userBId, orgBId);
    await request(app.getHttpServer())
      .post('/api/v1/backup/exports')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
  });

  // ─── Création et listing ─────────────────────────────────────────────────────

  let exportId: string;

  it('POST /api/v1/backup/exports avec token valide → 201 + { exportId }', async () => {
    const token = makeToken(userAId, orgAId);
    const res = await request(app.getHttpServer())
      .post('/api/v1/backup/exports')
      .set('Authorization', `Bearer ${token}`)
      .send({ format: 'CSV' })
      .expect(201);

    expect(res.body).toHaveProperty('exportId');
    expect(typeof (res.body as { exportId: string }).exportId).toBe('string');
    exportId = (res.body as { exportId: string }).exportId;
  });

  it('GET /api/v1/backup/exports → liste paginée incluant le dernier export', async () => {
    const token = makeToken(userAId, orgAId);
    const res = await request(app.getHttpServer())
      .get('/api/v1/backup/exports')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = res.body as { data: Array<{ id: string }>; total: number };
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((e) => e.id === exportId)).toBe(true);
    // errorMessage ne doit jamais apparaître
    for (const item of body.data) {
      expect('errorMessage' in item).toBe(false);
    }
  });

  // ─── Téléchargement ──────────────────────────────────────────────────────────

  it('GET /api/v1/backup/exports/:id/download après complétion → fichier téléchargeable', async () => {
    // Simuler la complétion en appelant directement le service (comme prescrit par la session)
    const filePath = backupService.buildFilePath(orgAId, exportId, 'CSV');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, 'id,name\n1,test\n', 'utf-8');
    createdFilePaths.push(filePath);

    await prisma.backupExport.update({
      where: { id: exportId },
      data: {
        status: 'COMPLETED',
        filename: `export-${exportId}.csv`,
        sizeBytes: fs.statSync(filePath).size,
        completedAt: new Date(),
      },
    });

    const token = makeToken(userAId, orgAId);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backup/exports/${exportId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it("GET /api/v1/backup/exports/:id/download avec exportId d'une autre org → 403", async () => {
    const tokenB = makeToken(userBId, orgBId);
    await request(app.getHttpServer())
      .get(`/api/v1/backup/exports/${exportId}/download`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
  });

  // ─── Suppression ────────────────────────────────────────────────────────────

  it('DELETE /api/v1/backup/exports/:id → 204, fichier physique supprimé', async () => {
    const token = makeToken(userAId, orgAId);
    const filePath = backupService.buildFilePath(orgAId, exportId, 'CSV');

    await request(app.getHttpServer())
      .delete(`/api/v1/backup/exports/${exportId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // Fichier physique supprimé
    expect(fs.existsSync(filePath)).toBe(false);
    // Entrée BDD supprimée
    const record = await prisma.backupExport.findUnique({ where: { id: exportId } });
    expect(record).toBeNull();

    // Retirer du tableau de nettoyage (déjà supprimé)
    const idx = createdFilePaths.indexOf(filePath);
    if (idx !== -1) createdFilePaths.splice(idx, 1);
  });
});
