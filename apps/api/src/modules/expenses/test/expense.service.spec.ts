import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { ExpenseService } from '../expense.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID = 'user0000-0000-0000-0000-000000000001';
const CATEGORY_ID = 'cat00001-0000-0000-0000-000000000001';
const WH_ID = 'wh000001-0000-0000-0000-000000000001';
const EXPENSE_ID = 'exp00001-0000-0000-0000-000000000001';
const REF = 'DEP-2026-000001';

function makeExpense(overrides: Partial<{
  id: string;
  organizationId: string;
  userId: string;
  deletedAt: Date | null;
  amount: Decimal;
  details: string;
}> = {}) {
  return {
    id: EXPENSE_ID,
    organizationId: ORG_A,
    date: new Date('2026-08-01'),
    reference: REF,
    userId: USER_ID,
    expenseCategoryId: CATEGORY_ID,
    warehouseId: WH_ID,
    details: 'Carburant véhicule de livraison',
    amount: new Decimal('25000'),
    deletedAt: null,
    createdAt: new Date('2026-08-01'),
    updatedAt: new Date('2026-08-01'),
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('ExpenseService', () => {
  let service: ExpenseService;

  let prisma: {
    expenseCategory: { findUnique: jest.Mock };
    warehouse: { findUnique: jest.Mock };
    expense: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };

  beforeEach(async () => {
    const prismaMock = {
      expenseCategory: { findUnique: jest.fn() },
      warehouse: { findUnique: jest.fn() },
      expense: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    prismaMock.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)(prismaMock);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });

    const dcMock = { nextReference: jest.fn().mockResolvedValue(REF) };

    const module = await Test.createTestingModule({
      providers: [
        ExpenseService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
      ],
    }).compile();

    service = module.get(ExpenseService);
    prisma = prismaMock;
    documentCounter = dcMock;
  });

  afterEach(() => jest.clearAllMocks());

  function baseDto(overrides: Record<string, unknown> = {}) {
    return {
      date: '2026-08-01T00:00:00.000Z',
      expenseCategoryId: CATEGORY_ID,
      warehouseId: WH_ID,
      details: 'Carburant véhicule de livraison',
      amount: '25000',
      ...overrides,
    };
  }

  function mockOwnershipOk() {
    prisma.expenseCategory.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
  }

  // ─── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('crée une dépense avec référence DEP-… générée via DocumentCounterService', async () => {
      mockOwnershipOk();
      prisma.expense.create.mockResolvedValue(makeExpense());

      const result = await service.create(ORG_A, USER_ID, baseDto());

      expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
      expect(result.reference).toBe(REF);
      expect(prisma.expense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: ORG_A,
            userId: USER_ID,
            reference: REF,
            expenseCategoryId: CATEGORY_ID,
            warehouseId: WH_ID,
            details: 'Carburant véhicule de livraison',
          }),
        }),
      );
      const createArgs = prisma.expense.create.mock.calls[0][0] as { data: { amount: Decimal } };
      expect(createArgs.data.amount).toBeInstanceOf(Decimal);
      expect(createArgs.data.amount.toString()).toBe('25000');
    });

    it("lève NotFoundException si la catégorie de dépense est introuvable", async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(null);
      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(NotFoundException);
      expect(prisma.expense.create).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si la catégorie de dépense appartient à une autre organisation (IDOR)", async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });
      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
      expect(prisma.expense.create).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si l'entrepôt appartient à une autre organisation (IDOR)", async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });
      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
      expect(prisma.expense.create).not.toHaveBeenCalled();
    });

    it("lève NotFoundException si l'entrepôt est introuvable", async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.warehouse.findUnique.mockResolvedValue(null);
      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(NotFoundException);
    });
  });

  // ─── findAll ─────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('viewAll=false injecte un filtre userId', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      await service.findAll(ORG_A, USER_ID, false, 1, 20);

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: ORG_A, userId: USER_ID }),
        }),
      );
    });

    it('viewAll=true ne filtre pas par userId', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      await service.findAll(ORG_A, USER_ID, true, 1, 20);

      const callArg = prisma.expense.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(callArg.where).not.toHaveProperty('userId');
    });

    it('filtre par expenseCategoryId/warehouseId/date quand fournis', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      await service.findAll(ORG_A, USER_ID, true, 1, 20, CATEGORY_ID, WH_ID, '2026-08-01T00:00:00.000Z');

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expenseCategoryId: CATEGORY_ID,
            warehouseId: WH_ID,
            date: new Date('2026-08-01T00:00:00.000Z'),
          }),
        }),
      );
    });
  });

  // ─── findOne ─────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('lève NotFoundException si la dépense est introuvable', async () => {
      prisma.expense.findUnique.mockResolvedValue(null);
      await expect(service.findOne(EXPENSE_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('lève NotFoundException si la dépense est soft-deleted', async () => {
      prisma.expense.findUnique.mockResolvedValue(makeExpense({ deletedAt: new Date() }));
      await expect(service.findOne(EXPENSE_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('lève ForbiddenException si la dépense appartient à une autre org (IDOR)', async () => {
      prisma.expense.findUnique.mockResolvedValue(makeExpense({ organizationId: ORG_B }));
      await expect(service.findOne(EXPENSE_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it('retourne la dépense si tout est valide', async () => {
      prisma.expense.findUnique.mockResolvedValue(makeExpense());
      const result = await service.findOne(EXPENSE_ID, ORG_A);
      expect(result.reference).toBe(REF);
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────

  describe('update', () => {
    it('lève NotFoundException si la dépense est introuvable', async () => {
      prisma.expense.findUnique.mockResolvedValue(null);
      await expect(service.update(EXPENSE_ID, ORG_A, { details: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lève ForbiddenException si la dépense appartient à une autre org', async () => {
      prisma.expense.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });
      await expect(service.update(EXPENSE_ID, ORG_A, { details: 'x' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('met à jour une dépense sans restriction de statut (aucun statut sur ce modèle)', async () => {
      prisma.expense.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.expense.update.mockResolvedValue(makeExpense({ details: 'Péage autoroute' }));

      const result = await service.update(EXPENSE_ID, ORG_A, { details: 'Péage autoroute' });
      expect(result.details).toBe('Péage autoroute');
    });

    it("re-vérifie l'ownership de expenseCategoryId si fourni", async () => {
      prisma.expense.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.expenseCategory.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

      await expect(
        service.update(EXPENSE_ID, ORG_A, { expenseCategoryId: CATEGORY_ID }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });

    it("re-vérifie l'ownership de warehouseId si fourni", async () => {
      prisma.expense.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

      await expect(
        service.update(EXPENSE_ID, ORG_A, { warehouseId: WH_ID }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('effectue un soft-delete (deletedAt = now)', async () => {
      prisma.expense.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.expense.update.mockResolvedValue(makeExpense({ deletedAt: new Date() }));

      await service.remove(EXPENSE_ID, ORG_A);

      expect(prisma.expense.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EXPENSE_ID },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it("lève ForbiddenException si la dépense appartient à une autre org", async () => {
      prisma.expense.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });
      await expect(service.remove(EXPENSE_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it("lève NotFoundException si la dépense n'existe pas", async () => {
      prisma.expense.findUnique.mockResolvedValue(null);
      await expect(service.remove(EXPENSE_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('lève NotFoundException si la dépense est déjà soft-deleted', async () => {
      prisma.expense.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: new Date() });
      await expect(service.remove(EXPENSE_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });
  });
});
