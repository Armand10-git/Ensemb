import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { getQueueToken } from '@nestjs/bullmq';
import { PartnersService } from '../partners.service';
import { PrismaService } from '../../../common/prisma.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = '00000000-0000-0000-0000-000000000001';
const ORG_B = '00000000-0000-0000-0000-000000000002';
const CLI_ID = '00000000-0000-0000-0000-000000000010';

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CLI_ID,
    organizationId: ORG_A,
    code: 1,
    name: 'Acme Corp',
    email: 'contact@acme.cm',
    phone: null,
    country: 'CM',
    city: 'Douala',
    address: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

type PrismaMock = {
  client: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    aggregate: jest.Mock;
  };
  provider: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    aggregate: jest.Mock;
  };
  $transaction: jest.Mock;
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('PartnersService', () => {
  let service: PartnersService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    const mock: PrismaMock = {
      client: {
        findMany:   jest.fn(),
        findUnique: jest.fn(),
        count:      jest.fn(),
        create:     jest.fn(),
        update:     jest.fn(),
        aggregate:  jest.fn(),
      },
      provider: {
        findMany:   jest.fn(),
        findUnique: jest.fn(),
        count:      jest.fn(),
        create:     jest.fn(),
        update:     jest.fn(),
        aggregate:  jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        PartnersService,
        { provide: PrismaService, useValue: mock },
        { provide: getQueueToken('excel'), useValue: { add: jest.fn().mockResolvedValue({ id: 'job-1' }) } },
      ],
    }).compile();

    service = module.get(PartnersService);
    prisma  = mock;
  });

  // ── findAllClients ─────────────────────────────────────────────────────────

  describe('findAllClients', () => {
    it('scope par org et exclut les soft-deleted', async () => {
      const client = makeClient();
      prisma.client.findMany.mockResolvedValue([client]);
      prisma.client.count.mockResolvedValue(1);

      const result = await service.findAllClients(ORG_A, 1, 20);

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_A, deletedAt: null }) }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('filtre sur name si search fourni', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.findAllClients(ORG_A, 1, 20, 'acme');

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: expect.objectContaining({ contains: 'acme' }) }),
            ]),
          }),
        }),
      );
    });
  });

  // ── createClient ───────────────────────────────────────────────────────────

  describe('createClient', () => {
    it('génère code = max + 1 dans une transaction SERIALIZABLE', async () => {
      const client = makeClient({ code: 3 });
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          client: {
            aggregate: jest.fn().mockResolvedValue({ _max: { code: 2 } }),
            create:    jest.fn().mockResolvedValue(client),
          },
        };
        return fn(tx);
      });

      const result = await service.createClient(ORG_A, { name: 'Acme Corp', email: 'contact@acme.cm' });

      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      );
      expect(result.code).toBe(3);
    });

    it("code = 1 pour le premier client de l'org", async () => {
      const client = makeClient({ code: 1 });
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          client: {
            aggregate: jest.fn().mockResolvedValue({ _max: { code: null } }),
            create:    jest.fn().mockResolvedValue(client),
          },
        };
        return fn(tx);
      });

      const result = await service.createClient(ORG_A, { name: 'Premier' });
      expect(result.code).toBe(1);
    });
  });

  // ── findOneClient ──────────────────────────────────────────────────────────

  describe('findOneClient', () => {
    it('lève ForbiddenException si autre org', async () => {
      prisma.client.findUnique.mockResolvedValue(makeClient({ organizationId: ORG_B, deletedAt: null }));
      await expect(service.findOneClient(CLI_ID, ORG_A)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lève NotFoundException si soft-deleted', async () => {
      prisma.client.findUnique.mockResolvedValue(makeClient({ deletedAt: new Date() }));
      await expect(service.findOneClient(CLI_ID, ORG_A)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── removeClient ───────────────────────────────────────────────────────────

  describe('removeClient', () => {
    it('lève ForbiddenException si ownership incorrect', async () => {
      prisma.client.findUnique.mockResolvedValue(makeClient({ organizationId: ORG_B, deletedAt: null }));
      await expect(service.removeClient(CLI_ID, ORG_A)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('effectue un soft-delete (deletedAt = now)', async () => {
      prisma.client.findUnique.mockResolvedValue(makeClient());
      prisma.client.update.mockResolvedValue({});

      await service.removeClient(CLI_ID, ORG_A);

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: CLI_ID },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      });
    });
  });

  // ── importFromCsv ──────────────────────────────────────────────────────────

  describe('importFromCsv', () => {
    it('importe 3 lignes valides et rapporte 1 erreur (email malformé)', async () => {
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          client: {
            aggregate: jest.fn().mockResolvedValue({ _max: { code: 0 } }),
            create:    jest.fn().mockImplementation((args: { data: { name: string; code: number } }) =>
              Promise.resolve({ ...makeClient(), name: args.data.name, code: args.data.code }),
            ),
          },
        };
        return fn(tx);
      });

      const csv = Buffer.from(
        'name,email,phone,country,city,address\n' +
        'Client A,a@test.cm,+237123,CM,Douala,\n' +
        'Client B,b@test.cm,,,Yaoundé,\n' +
        'Client C,c@test.cm,,CM,,\n' +
        'Client D,not-an-email,,,,\n',
      );

      const report = await service.importFromCsv(ORG_A, 'clients', csv);

      expect(report.imported).toBe(3);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]!.line).toBe(5);
    });

    it('fichier vide → imported: 0, errors: []', async () => {
      const csv = Buffer.from('name,email,phone,country,city,address\n');
      const report = await service.importFromCsv(ORG_A, 'clients', csv);
      expect(report.imported).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  // ── requestExcelExport ─────────────────────────────────────────────────────

  describe('requestExcelExport', () => {
    it('enfile un job excel et retourne le jobId', async () => {
      const result = await service.requestExcelExport(ORG_A, 'clients');
      expect(result).toHaveProperty('jobId', 'job-1');
    });
  });

  // ── resolveExportPath ──────────────────────────────────────────────────────

  describe('resolveExportPath', () => {
    it("lève ForbiddenException si le filename n'appartient pas à l'org", () => {
      expect(() =>
        service.resolveExportPath(ORG_A, `${ORG_B}-clients-123.xlsx`),
      ).toThrow(ForbiddenException);
    });
  });
});
