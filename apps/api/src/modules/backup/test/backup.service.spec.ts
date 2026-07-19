import * as fs from 'fs';
import * as nodePath from 'path';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { BackupService } from '../backup.service';
import { PrismaService } from '../../../common/prisma.service';

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';
const EXPORT_ID = 'export-111';

const makeExport = (overrides: Partial<{
  id: string;
  organizationId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  format: 'CSV' | 'JSON';
  filename: string | null;
  sizeBytes: number | null;
  requestedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}> = {}) => ({
  id: EXPORT_ID,
  organizationId: ORG_A,
  status: 'COMPLETED' as const,
  format: 'CSV' as const,
  filename: `export-${EXPORT_ID}.csv`,
  sizeBytes: 512,
  requestedAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: new Date('2026-01-01T00:01:00Z'),
  errorMessage: null,
  ...overrides,
});

describe('BackupService', () => {
  let service: BackupService;
  let prisma: jest.Mocked<PrismaService>;
  let backupQueue: jest.Mocked<Queue>;

  beforeEach(async () => {
    const prismaMock = {
      backupExport: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        update: jest.fn(),
      },
    };

    const queueMock = { add: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: getQueueToken('backup'), useValue: queueMock },
      ],
    }).compile();

    service = moduleRef.get(BackupService);
    prisma = moduleRef.get(PrismaService) as jest.Mocked<PrismaService>;
    backupQueue = moduleRef.get(getQueueToken('backup')) as jest.Mocked<Queue>;
  });

  describe('requestExport', () => {
    it('crée un BackupExport PENDING et enfile le job', async () => {
      const created = makeExport({ status: 'PENDING', completedAt: null });
      (prisma.backupExport.create as jest.Mock).mockResolvedValue(created);
      (backupQueue.add as jest.Mock).mockResolvedValue(undefined);

      const result = await service.requestExport(ORG_A, 'CSV');

      expect(prisma.backupExport.create).toHaveBeenCalledWith({
        data: { organizationId: ORG_A, format: 'CSV', status: 'PENDING' },
      });
      expect(backupQueue.add).toHaveBeenCalledWith('export.generate', {
        exportId: EXPORT_ID,
        organizationId: ORG_A,
        format: 'CSV',
      });
      expect(result).toEqual({ exportId: EXPORT_ID });
    });
  });

  describe('listExports', () => {
    it("retourne uniquement les exports de l'org courante", async () => {
      // Le select Prisma exclut errorMessage — le mock doit refléter ce que Prisma retournerait réellement
      const { errorMessage, organizationId, ...orgAExportSummary } = makeExport();
      void errorMessage; void organizationId;
      (prisma.backupExport.count as jest.Mock).mockResolvedValue(1);
      (prisma.backupExport.findMany as jest.Mock).mockResolvedValue([orgAExportSummary]);

      const result = await service.listExports(ORG_A, 1, 20);

      expect(prisma.backupExport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG_A } }),
      );
      expect(result.data).toHaveLength(1);
      const first = result.data[0];
      expect(first).toBeDefined();
      expect(first!.id).toBe(EXPORT_ID);
      // errorMessage ne doit jamais apparaître dans le résultat
      expect('errorMessage' in first!).toBe(false);
    });
  });

  describe('getDownloadStream', () => {
    it("lève ForbiddenException si l'exportId appartient à une autre org", async () => {
      (prisma.backupExport.findUnique as jest.Mock).mockResolvedValue(
        makeExport({ organizationId: ORG_B }),
      );

      await expect(service.getDownloadStream(EXPORT_ID, ORG_A)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lève BadRequestException si status !== COMPLETED', async () => {
      (prisma.backupExport.findUnique as jest.Mock).mockResolvedValue(
        makeExport({ status: 'PENDING' }),
      );

      await expect(service.getDownloadStream(EXPORT_ID, ORG_A)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('retourne un ReadStream pour un export COMPLETED valide', async () => {
      const exp = makeExport();
      (prisma.backupExport.findUnique as jest.Mock).mockResolvedValue(exp);

      const filePath = service.buildFilePath(ORG_A, EXPORT_ID, 'CSV');
      const dir = nodePath.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, 'id,name\n1,test\n', 'utf-8');

      try {
        const result = await service.getDownloadStream(EXPORT_ID, ORG_A);
        expect(result.stream).toBeDefined();
        expect(result.filename).toBe(`export-${EXPORT_ID}.csv`);
        expect(result.mimeType).toBe('text/csv');
        result.stream.on('error', () => undefined); // swallow close-after-delete
        result.stream.destroy();
      } finally {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    });
  });

  describe('deleteExport', () => {
    it("lève ForbiddenException si l'exportId appartient à une autre org", async () => {
      (prisma.backupExport.findUnique as jest.Mock).mockResolvedValue(
        makeExport({ organizationId: ORG_B }),
      );

      await expect(service.deleteExport(EXPORT_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si inexistant', async () => {
      (prisma.backupExport.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteExport(EXPORT_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });
  });

  describe('purgeOldExports', () => {
    it('supprime les exports plus vieux que retentionDays, pas les récents', async () => {
      const old = makeExport({
        id: 'old-export',
        status: 'COMPLETED',
        requestedAt: new Date('2025-01-01T00:00:00Z'),
        filename: null,
      });
      (prisma.backupExport.findMany as jest.Mock).mockResolvedValue([old]);
      (prisma.backupExport.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.purgeOldExports(ORG_A, 30);

      expect(prisma.backupExport.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['old-export'] } },
      });
    });

    it('ne supprime rien si aucun export expiré', async () => {
      (prisma.backupExport.findMany as jest.Mock).mockResolvedValue([]);

      await service.purgeOldExports(ORG_A, 30);

      expect(prisma.backupExport.deleteMany).not.toHaveBeenCalled();
    });
  });
});
