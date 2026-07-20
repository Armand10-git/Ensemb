import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WarehouseService } from '../warehouse.service';
import { PrismaService } from '../../../common/prisma.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'org-aaaa-aaaa-aaaa-aaaa';
const ORG_B = 'org-bbbb-bbbb-bbbb-bbbb';
const WH_ID_1 = 'wh-1111-1111-1111-1111';
const WH_ID_2 = 'wh-2222-2222-2222-2222';

function makeWarehouse(overrides: Partial<{
  id: string;
  organizationId: string;
  name: string;
  address: string | null;
  isDefault: boolean;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: WH_ID_1,
    organizationId: ORG_A,
    name: 'Principal',
    address: null,
    isDefault: false,
    version: 0,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

type PrismaMock = {
  warehouse: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('WarehouseService', () => {
  let service: WarehouseService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    const mock: PrismaMock = {
      warehouse: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        WarehouseService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();

    service = module.get(WarehouseService);
    prisma = mock;
  });

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it("ne retourne que les entrepôts de l'organisation scopée", async () => {
      const wh = makeWarehouse();
      prisma.warehouse.findMany.mockResolvedValue([wh]);
      prisma.warehouse.count.mockResolvedValue(1);

      const result = await service.findAll(ORG_A, 1, 20);

      expect(prisma.warehouse.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG_A, deletedAt: null } }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe('Principal');
    });

    it('exclut les entrepôts soft-deleted', async () => {
      prisma.warehouse.findMany.mockResolvedValue([]);
      prisma.warehouse.count.mockResolvedValue(0);

      const result = await service.findAll(ORG_A, 1, 20);

      const callArg = prisma.warehouse.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(callArg.where).toMatchObject({ deletedAt: null });
      expect(result.data).toHaveLength(0);
    });

    it('retourne la pagination correcte', async () => {
      prisma.warehouse.findMany.mockResolvedValue([makeWarehouse()]);
      prisma.warehouse.count.mockResolvedValue(25);

      const result = await service.findAll(ORG_A, 2, 10);

      expect(result.total).toBe(25);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
    });
  });

  // ── findOne ──────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it("lève NotFoundException si l'entrepôt est introuvable", async () => {
      prisma.warehouse.findUnique.mockResolvedValue(null);
      await expect(service.findOne(WH_ID_1, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève NotFoundException si l'entrepôt est soft-deleted", async () => {
      prisma.warehouse.findUnique.mockResolvedValue(makeWarehouse({ deletedAt: new Date() }));
      await expect(service.findOne(WH_ID_1, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si l'entrepôt appartient à une autre org", async () => {
      prisma.warehouse.findUnique.mockResolvedValue(makeWarehouse({ organizationId: ORG_B }));
      await expect(service.findOne(WH_ID_1, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it("retourne l'entrepôt si tout est valide", async () => {
      prisma.warehouse.findUnique.mockResolvedValue(makeWarehouse());
      const result = await service.findOne(WH_ID_1, ORG_A);
      expect(result.name).toBe('Principal');
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it("crée un entrepôt sans modifier isDefault des autres si isDefault est false", async () => {
      const created = makeWarehouse({ name: 'Nouveau' });
      prisma.$transaction.mockImplementation(async (fn: (tx: PrismaMock) => Promise<unknown>) => {
        const txMock: PrismaMock = {
          warehouse: {
            ...prisma.warehouse,
            create: jest.fn().mockResolvedValue(created),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            count: jest.fn(),
            update: jest.fn(),
          },
          $transaction: jest.fn(),
        };
        return fn(txMock);
      });

      const result = await service.create(ORG_A, { name: 'Nouveau', isDefault: false });
      expect(result.name).toBe('Nouveau');
    });

    it('retire isDefault des autres entrepôts si isDefault est true (même transaction)', async () => {
      const created = makeWarehouse({ name: 'Principal', isDefault: true });
      let updateManyCalled = false;
      let createCalledAfterUpdateMany = false;

      prisma.$transaction.mockImplementation(async (fn: (tx: PrismaMock) => Promise<unknown>) => {
        const txMock: PrismaMock = {
          warehouse: {
            ...prisma.warehouse,
            updateMany: jest.fn().mockImplementation(async () => {
              updateManyCalled = true;
              return { count: 1 };
            }),
            create: jest.fn().mockImplementation(async () => {
              if (updateManyCalled) createCalledAfterUpdateMany = true;
              return created;
            }),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            count: jest.fn(),
            update: jest.fn(),
          },
          $transaction: jest.fn(),
        };
        return fn(txMock);
      });

      await service.create(ORG_A, { name: 'Principal', isDefault: true });
      expect(updateManyCalled).toBe(true);
      expect(createCalledAfterUpdateMany).toBe(true);
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it("lève BadRequestException si c'est le seul entrepôt actif", async () => {
      prisma.warehouse.findUnique.mockResolvedValue(makeWarehouse());
      prisma.warehouse.count.mockResolvedValue(1);
      await expect(service.remove(WH_ID_1, ORG_A)).rejects.toThrow(BadRequestException);
    });

    it("effectue un soft-delete si d'autres entrepôts actifs existent", async () => {
      prisma.warehouse.findUnique.mockResolvedValue(makeWarehouse());
      prisma.warehouse.count.mockResolvedValue(2);
      prisma.warehouse.update.mockResolvedValue({ ...makeWarehouse(), deletedAt: new Date() });

      await service.remove(WH_ID_1, ORG_A);

      expect(prisma.warehouse.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: WH_ID_1 },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it("lève ForbiddenException si l'entrepôt appartient à une autre org", async () => {
      prisma.warehouse.findUnique.mockResolvedValue(makeWarehouse({ organizationId: ORG_B }));
      await expect(service.remove(WH_ID_1, ORG_A)).rejects.toThrow(ForbiddenException);
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it("lève NotFoundException si l'entrepôt n'appartient pas à l'org", async () => {
      prisma.warehouse.findUnique.mockResolvedValue(null);
      await expect(service.update(WH_ID_1, ORG_A, { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('retire isDefault des autres entrepôts si isDefault passe à true', async () => {
      const existing = makeWarehouse();
      prisma.warehouse.findUnique.mockResolvedValue(existing);

      let updateManyCount = 0;
      prisma.$transaction.mockImplementation(async (fn: (tx: PrismaMock) => Promise<unknown>) => {
        const txMock: PrismaMock = {
          warehouse: {
            ...prisma.warehouse,
            updateMany: jest.fn().mockImplementation(async () => {
              updateManyCount++;
              return { count: 1 };
            }),
            update: jest.fn().mockResolvedValue({ ...existing, isDefault: true, id: WH_ID_2 }),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            count: jest.fn(),
            create: jest.fn(),
          },
          $transaction: jest.fn(),
        };
        return fn(txMock);
      });

      await service.update(WH_ID_2, ORG_A, { isDefault: true });
      expect(updateManyCount).toBe(1);
    });
  });
});
