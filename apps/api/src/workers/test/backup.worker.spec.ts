import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { BackupWorker } from '../backup.worker';
import { BackupService } from '../../modules/backup/backup.service';
import { PrismaService } from '../../common/prisma.service';
import { RealtimeGateway } from '../../modules/realtime/realtime.gateway';

const ORG_A = 'org-worker-aaa';

const makeJob = (name: string, data: object) =>
  ({ name, data }) as import('bullmq').Job;

describe('BackupWorker', () => {
  let worker: BackupWorker;
  let prisma: { backupExport: { update: jest.Mock; findMany: jest.Mock; deleteMany: jest.Mock }; user: { findMany: jest.Mock }; role: { findMany: jest.Mock }; roleOnUser: { findMany: jest.Mock } };
  let backupService: { buildFilePath: jest.Mock; purgeOldExports: jest.Mock };
  let realtimeGateway: { server: { to: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      backupExport: { update: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
      user: { findMany: jest.fn() },
      role: { findMany: jest.fn() },
      roleOnUser: { findMany: jest.fn() },
    };

    backupService = {
      buildFilePath: jest.fn(),
      purgeOldExports: jest.fn(),
    };

    const emitMock = jest.fn();
    const toMock = jest.fn(() => ({ emit: emitMock }));
    realtimeGateway = { server: { to: toMock } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BackupWorker,
        { provide: PrismaService, useValue: prisma },
        { provide: BackupService, useValue: backupService },
        { provide: RealtimeGateway, useValue: realtimeGateway },
        { provide: getQueueToken('backup'), useValue: { add: jest.fn() } },
      ],
    }).compile();

    worker = moduleRef.get(BackupWorker);
  });

  describe('export.generate — CSV', () => {
    it('produit un fichier contenant uniquement les données de org A, pas org B', async () => {
      const exportId = 'export-csv-test';
      const tmpPath = path.join(process.cwd(), 'storage', 'exports', ORG_A, `${exportId}.csv`);
      backupService.buildFilePath.mockReturnValue(tmpPath);

      const orgAUsers = [
        { id: 'u1', firstname: 'Alice', lastname: 'A', email: 'a@a.com', username: 'alice', isActive: true, createdAt: new Date() },
      ];
      const orgBUser = { id: 'u2', firstname: 'Bob', lastname: 'B', email: 'b@b.com', username: 'bob', isActive: true, createdAt: new Date() };

      // user.findMany filtre sur organizationId ORG_A — jamais orgBUser
      prisma.user.findMany.mockImplementation(({ where }: { where?: { organizationId?: string } }) =>
        Promise.resolve(where?.organizationId === ORG_A ? orgAUsers : []),
      );
      prisma.role.findMany.mockResolvedValue([]);
      prisma.roleOnUser.findMany.mockResolvedValue([]);
      prisma.backupExport.update.mockResolvedValue({});

      const dir = path.dirname(tmpPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      try {
        await worker.process(makeJob('export.generate', {
          exportId,
          organizationId: ORG_A,
          format: 'CSV',
        }));

        expect(fs.existsSync(tmpPath)).toBe(true);
        const content = fs.readFileSync(tmpPath, 'utf-8');
        expect(content).toContain('alice');
        expect(content).not.toContain(orgBUser.username);

        expect(prisma.backupExport.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
        );
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    });
  });

  describe('export.generate — JSON', () => {
    it('produit une structure JSON valide sans données cross-tenant', async () => {
      const exportId = 'export-json-test';
      const tmpPath = path.join(process.cwd(), 'storage', 'exports', ORG_A, `${exportId}.json`);
      backupService.buildFilePath.mockReturnValue(tmpPath);

      const orgARole = { id: 'r1', name: 'admin', label: 'Admin', status: true };
      prisma.user.findMany.mockResolvedValue([]);
      prisma.role.findMany.mockImplementation(({ where }: { where?: { organizationId?: string } }) =>
        Promise.resolve(where?.organizationId === ORG_A ? [orgARole] : []),
      );
      prisma.roleOnUser.findMany.mockResolvedValue([]);
      prisma.backupExport.update.mockResolvedValue({});

      const dir = path.dirname(tmpPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      try {
        await worker.process(makeJob('export.generate', {
          exportId,
          organizationId: ORG_A,
          format: 'JSON',
        }));

        expect(fs.existsSync(tmpPath)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf-8')) as { roles: { id: string }[] };
        expect(parsed.roles).toHaveLength(1);
        const firstRole = parsed.roles[0];
        expect(firstRole).toBeDefined();
        expect(firstRole!.id).toBe('r1');
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    });
  });

  describe('export.generate — erreur Prisma', () => {
    it('passe le statut à FAILED, logue, ne propage pas au client', async () => {
      const exportId = 'export-fail-test';
      const tmpPath = path.join(process.cwd(), 'storage', 'exports', ORG_A, `${exportId}.csv`);
      backupService.buildFilePath.mockReturnValue(tmpPath);

      const prismaError = new Error('DB connection lost');
      prisma.user.findMany.mockRejectedValue(prismaError);
      prisma.backupExport.update.mockResolvedValue({});

      // Ne doit pas lever d'exception (le worker gère lui-même l'erreur)
      await expect(
        worker.process(makeJob('export.generate', {
          exportId,
          organizationId: ORG_A,
          format: 'CSV',
        })),
      ).resolves.toBeUndefined();

      // Le second appel update → FAILED
      const updateCalls = (prisma.backupExport.update as jest.Mock).mock.calls;
      const failedCall = updateCalls.find(
        (c: Array<{ data?: { status?: string } }>) => c[0]?.data?.status === 'FAILED',
      );
      expect(failedCall).toBeDefined();
      expect(failedCall[0].data.errorMessage).toBe('DB connection lost');
    });
  });
});
