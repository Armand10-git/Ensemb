import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { CashSessionService } from '../cash-session.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A  = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B  = 'bbbb0000-0000-0000-0000-000000000002';
const USER_A = 'user0000-0000-0000-0000-000000000001';
const USER_B = 'user0000-0000-0000-0000-000000000002';
const WH_ID  = 'wh000001-0000-0000-0000-000000000001';
const CS_ID  = 'cs000001-0000-0000-0000-000000000001';
const REF    = 'CS-2026-000001';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: CS_ID,
    organizationId: ORG_A,
    reference: REF,
    warehouseId: WH_ID,
    userId: USER_A,
    openingAmount: new Decimal('5000'),
    expectedClosingAmount: null,
    countedClosingAmount: null,
    variance: null,
    status: 'OPEN',
    notes: null,
    openedAt: new Date('2026-07-28T08:00:00Z'),
    closedAt: null,
    ...overrides,
  };
}

describe('CashSessionService', () => {
  let service: CashSessionService;

  let prisma: {
    warehouse: { findUnique: jest.Mock };
    cashSession: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    paymentSale: { aggregate: jest.Mock };
    sale: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };

  beforeEach(() => {
    const prismaMock = {
      warehouse: { findUnique: jest.fn() },
      cashSession: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      paymentSale: { aggregate: jest.fn() },
      sale: { findMany: jest.fn() },
      $transaction: jest.fn(),
    };

    prismaMock.$transaction.mockImplementation((arg: unknown, _opts?: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)(prismaMock);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });

    const dcMock = { nextReference: jest.fn().mockResolvedValue(REF) };

    service = new CashSessionService(prismaMock as never, dcMock as never);
    prisma = prismaMock;
    documentCounter = dcMock;
  });

  afterEach(() => jest.clearAllMocks());

  // ─── open ────────────────────────────────────────────────────────────────

  describe('open', () => {
    it('refuse une seconde session pour le même caissier (409)', async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.cashSession.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        service.open(ORG_A, USER_A, { warehouseId: WH_ID, openingAmount: '5000' }),
      ).rejects.toThrow(ConflictException);
      expect(documentCounter.nextReference).not.toHaveBeenCalled();
      expect(prisma.cashSession.create).not.toHaveBeenCalled();
    });

    it('ouvre une session avec référence générée via DocumentCounterService, jamais max+1', async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.cashSession.findFirst.mockResolvedValue(null);
      prisma.cashSession.create.mockResolvedValue(makeSession());

      const result = await service.open(ORG_A, USER_A, { warehouseId: WH_ID, openingAmount: '5000' });

      expect(documentCounter.nextReference).toHaveBeenCalledWith(expect.anything(), ORG_A, 'CASH_SESSION');
      const createArgs = prisma.cashSession.create.mock.calls[0][0] as {
        data: { organizationId: string; userId: string; status: string; openingAmount: Decimal };
      };
      expect(createArgs.data.organizationId).toBe(ORG_A);
      expect(createArgs.data.userId).toBe(USER_A);
      expect(createArgs.data.status).toBe('OPEN');
      expect(createArgs.data.openingAmount.toString()).toBe('5000');
      expect(result.status).toBe('OPEN');
    });

    it("entrepôt d'une autre organisation → ForbiddenException, aucune écriture", async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

      await expect(
        service.open(ORG_A, USER_A, { warehouseId: WH_ID, openingAmount: '5000' }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cashSession.findFirst).not.toHaveBeenCalled();
      expect(prisma.cashSession.create).not.toHaveBeenCalled();
    });

    it('entrepôt introuvable → NotFoundException', async () => {
      prisma.warehouse.findUnique.mockResolvedValue(null);

      await expect(
        service.open(ORG_A, USER_A, { warehouseId: WH_ID, openingAmount: '5000' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('violation P2002 concurrente (TOCTOU) sur le check applicatif → ConflictException, jamais une 500', async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.cashSession.findFirst.mockResolvedValue(null);
      prisma.cashSession.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique violation', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      await expect(
        service.open(ORG_A, USER_A, { warehouseId: WH_ID, openingAmount: '5000' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── findCurrent ─────────────────────────────────────────────────────────

  describe('findCurrent', () => {
    it('retourne null sans exception si aucune session OPEN (cas nominal avant la 1re vente)', async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.cashSession.findFirst.mockResolvedValue(null);

      await expect(service.findCurrent(ORG_A, USER_A, WH_ID)).resolves.toBeNull();
    });

    it('retourne la session OPEN du caller pour cet entrepôt', async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.cashSession.findFirst.mockResolvedValue(makeSession());

      const result = await service.findCurrent(ORG_A, USER_A, WH_ID);
      expect(result?.id).toBe(CS_ID);
    });
  });

  // ─── close ───────────────────────────────────────────────────────────────

  describe('close', () => {
    it('calcule expectedClosingAmount = openingAmount + CASH uniquement (exclut CARD/MOBILE_MONEY, exclut le hors-POS)', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ openingAmount: new Decimal('5000') }));
      // L'agrégat filtre déjà method=CASH ET sale.cashSessionId=id — seules les ventes POS
      // rattachées à CETTE session et payées en espèces contribuent (CARD/MOBILE_MONEY et les
      // ventes classiques, qui n'ont jamais de cashSessionId, sont exclues par construction).
      prisma.paymentSale.aggregate.mockResolvedValue({ _sum: { amount: new Decimal('12000') } });
      prisma.cashSession.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeSession({ ...data })),
      );

      const result = await service.close(CS_ID, ORG_A, USER_A, { countedClosingAmount: '17000' });

      expect(prisma.paymentSale.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: ORG_A,
            method: 'CASH',
            sale: { cashSessionId: CS_ID },
          }),
        }),
      );
      expect(result.expectedClosingAmount?.toString()).toBe('17000');
      expect(result.variance?.toString()).toBe('0');
      expect(result.status).toBe('CLOSED');
    });

    it('écart négatif (manque) quand le compté est inférieur à l’attendu', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ openingAmount: new Decimal('5000') }));
      prisma.paymentSale.aggregate.mockResolvedValue({ _sum: { amount: new Decimal('10000') } });
      prisma.cashSession.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeSession({ ...data })),
      );

      const result = await service.close(CS_ID, ORG_A, USER_A, { countedClosingAmount: '14500' });

      // attendu = 5000 + 10000 = 15000 ; compté = 14500 → écart = -500 (manque)
      expect(result.variance?.toString()).toBe('-500');
    });

    it('aucun paiement CASH rattaché → expectedClosingAmount = openingAmount seul', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ openingAmount: new Decimal('5000') }));
      prisma.paymentSale.aggregate.mockResolvedValue({ _sum: { amount: null } });
      prisma.cashSession.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeSession({ ...data })),
      );

      const result = await service.close(CS_ID, ORG_A, USER_A, { countedClosingAmount: '5000' });

      expect(result.expectedClosingAmount?.toString()).toBe('5000');
      expect(result.variance?.toString()).toBe('0');
    });

    it('session déjà CLOSED → BadRequestException', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ status: 'CLOSED' }));

      await expect(
        service.close(CS_ID, ORG_A, USER_A, { countedClosingAmount: '5000' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.cashSession.update).not.toHaveBeenCalled();
    });

    it("session appartenant à un autre utilisateur → ForbiddenException (un caissier ne clôture que SA session)", async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ userId: USER_B }));

      await expect(
        service.close(CS_ID, ORG_A, USER_A, { countedClosingAmount: '5000' }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cashSession.update).not.toHaveBeenCalled();
    });

    it("session d'une autre organisation → ForbiddenException (IDOR)", async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ organizationId: ORG_B }));

      await expect(
        service.close(CS_ID, ORG_A, USER_A, { countedClosingAmount: '5000' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('session introuvable → NotFoundException', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(null);

      await expect(
        service.close(CS_ID, ORG_A, USER_A, { countedClosingAmount: '5000' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── findOne — accès en détail (revue sécurité S23b) ────────────────────────

  describe('findOne', () => {
    it('le propriétaire de la session peut toujours consulter son propre détail (viewAll=false)', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ userId: USER_A }));
      prisma.sale.findMany.mockResolvedValue([]);

      const result = await service.findOne(CS_ID, ORG_A, USER_A, false);
      expect(result.id).toBe(CS_ID);
    });

    it("sans records.viewAll, un caissier ne peut PAS consulter le détail de la session d'un collègue (IDOR)", async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ userId: USER_B }));

      await expect(service.findOne(CS_ID, ORG_A, USER_A, false)).rejects.toThrow(ForbiddenException);
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
    });

    it('avec records.viewAll (viewAll=true), un manager peut consulter le détail de la session de n’importe quel caissier de son organisation', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ userId: USER_B }));
      prisma.sale.findMany.mockResolvedValue([]);

      await expect(service.findOne(CS_ID, ORG_A, USER_A, true)).resolves.toMatchObject({ id: CS_ID });
    });

    it("session d'une autre organisation → ForbiddenException même avec viewAll=true (l'isolation d'organisation prime)", async () => {
      prisma.cashSession.findUnique.mockResolvedValue(makeSession({ organizationId: ORG_B }));

      await expect(service.findOne(CS_ID, ORG_A, USER_A, true)).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── findOpenSessionInTransaction ────────────────────────────────────────

  describe('findOpenSessionInTransaction', () => {
    it('recherche par (organizationId, userId, warehouseId, status=OPEN) et retourne { id, reference }', async () => {
      prisma.cashSession.findFirst.mockResolvedValue({ id: CS_ID, reference: REF });

      const result = await service.findOpenSessionInTransaction(prisma as never, ORG_A, USER_A, WH_ID);

      expect(prisma.cashSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: ORG_A, userId: USER_A, warehouseId: WH_ID, status: 'OPEN' },
        }),
      );
      expect(result).toEqual({ id: CS_ID, reference: REF });
    });

    it('retourne null sans exception si aucune session OPEN', async () => {
      prisma.cashSession.findFirst.mockResolvedValue(null);

      await expect(
        service.findOpenSessionInTransaction(prisma as never, ORG_A, USER_A, WH_ID),
      ).resolves.toBeNull();
    });
  });
});
