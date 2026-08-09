import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { ExpenseCategoryService } from '../expense-category.service';
import { PrismaService } from '../../../common/prisma.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'org-aaaa-aaaa-aaaa-aaaa';
const ORG_B = 'org-bbbb-bbbb-bbbb-bbbb';
const CATEGORY_ID = 'cat-11111-1111-1111-1111';
const USER_ID = 'user-1111-1111-1111-1111';

function makeCategory(overrides: Partial<{
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  description: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: CATEGORY_ID,
    organizationId: ORG_A,
    userId: USER_ID,
    name: 'Transport',
    description: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

type PrismaMock = {
  expenseCategory: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('ExpenseCategoryService', () => {
  let service: ExpenseCategoryService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    const mock: PrismaMock = {
      expenseCategory: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        ExpenseCategoryService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();

    service = module.get(ExpenseCategoryService);
    prisma = mock;
  });

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it("ne retourne que les catégories de l'organisation scopée", async () => {
      const category = makeCategory();
      prisma.expenseCategory.findMany.mockResolvedValue([category]);
      prisma.expenseCategory.count.mockResolvedValue(1);

      const result = await service.findAll(ORG_A, 1, 20);

      expect(prisma.expenseCategory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG_A, deletedAt: null } }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe('Transport');
    });

    it('exclut les catégories soft-deleted', async () => {
      prisma.expenseCategory.findMany.mockResolvedValue([]);
      prisma.expenseCategory.count.mockResolvedValue(0);

      const result = await service.findAll(ORG_A, 1, 20);

      const callArg = prisma.expenseCategory.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(callArg.where).toMatchObject({ deletedAt: null });
      expect(result.data).toHaveLength(0);
    });

    it("ne retourne pas les catégories d'une autre organisation", async () => {
      prisma.expenseCategory.findMany.mockImplementation(
        ({ where }: { where: { organizationId: string } }) => {
          if (where.organizationId === ORG_B) {
            return Promise.resolve([makeCategory({ organizationId: ORG_B })]);
          }
          return Promise.resolve([]);
        },
      );
      prisma.expenseCategory.count.mockResolvedValue(0);

      const resultA = await service.findAll(ORG_A, 1, 20);
      expect(resultA.data).toHaveLength(0);
    });
  });

  // ── findOne ──────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('lève NotFoundException si la catégorie est introuvable', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(null);
      await expect(service.findOne(CATEGORY_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('lève NotFoundException si la catégorie est soft-deleted', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(makeCategory({ deletedAt: new Date() }));
      await expect(service.findOne(CATEGORY_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('lève ForbiddenException si la catégorie appartient à une autre org (IDOR)', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(makeCategory({ organizationId: ORG_B }));
      await expect(service.findOne(CATEGORY_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it('retourne la catégorie si tout est valide', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(makeCategory());
      const result = await service.findOne(CATEGORY_ID, ORG_A);
      expect(result.name).toBe('Transport');
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('crée une catégorie avec userId issu du token et retourne le résultat', async () => {
      const category = makeCategory({ name: 'Fournitures' });
      prisma.expenseCategory.create.mockResolvedValue(category);

      const result = await service.create(ORG_A, USER_ID, { name: 'Fournitures' });
      expect(result.name).toBe('Fournitures');
      expect(prisma.expenseCategory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ organizationId: ORG_A, userId: USER_ID }),
        }),
      );
    });

    it('P2002 sur le nom → ConflictException avec nom mentionné', async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['unique_expense_category_name_active'] },
      });
      prisma.expenseCategory.create.mockRejectedValue(err);

      await expect(service.create(ORG_A, USER_ID, { name: 'Transport' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('crée une catégorie avec description', async () => {
      const category = makeCategory({ name: 'Loyer', description: 'Loyer mensuel du local' });
      prisma.expenseCategory.create.mockResolvedValue(category);

      const result = await service.create(ORG_A, USER_ID, {
        name: 'Loyer',
        description: 'Loyer mensuel du local',
      });
      expect(result.description).toBe('Loyer mensuel du local');
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('effectue un soft-delete sans condition sur les dépenses existantes', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(makeCategory());
      prisma.expenseCategory.update.mockResolvedValue({ ...makeCategory(), deletedAt: new Date() });

      await service.remove(CATEGORY_ID, ORG_A);

      expect(prisma.expenseCategory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CATEGORY_ID },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('lève ForbiddenException si la catégorie appartient à une autre org', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(makeCategory({ organizationId: ORG_B }));
      await expect(service.remove(CATEGORY_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it("lève NotFoundException si la catégorie n'existe pas", async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(null);
      await expect(service.remove(CATEGORY_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('lève NotFoundException si la catégorie est introuvable', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(null);
      await expect(
        service.update(CATEGORY_ID, ORG_A, { name: 'Nouveau' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('met à jour une catégorie et retourne le résultat', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(makeCategory());
      prisma.expenseCategory.update.mockResolvedValue(makeCategory({ name: 'Carburant' }));

      const result = await service.update(CATEGORY_ID, ORG_A, { name: 'Carburant' });
      expect(result.name).toBe('Carburant');
    });

    it('P2002 sur le nom en update → ConflictException', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(makeCategory());
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['unique_expense_category_name_active'] },
      });
      prisma.expenseCategory.update.mockRejectedValue(err);

      await expect(service.update(CATEGORY_ID, ORG_A, { name: 'Loyer' })).rejects.toThrow(
        ConflictException,
      );
    });

    it("lève ForbiddenException si la catégorie appartient à une autre org", async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(makeCategory({ organizationId: ORG_B }));
      await expect(
        service.update(CATEGORY_ID, ORG_A, { name: 'Nouveau' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
