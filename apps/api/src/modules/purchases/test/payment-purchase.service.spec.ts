import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { PaymentPurchaseService } from '../payment-purchase.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A       = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B       = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID     = 'user0000-0000-0000-0000-000000000001';
const PURCHASE_ID = 'purc0001-0000-0000-0000-000000000001';
const PAYMENT_ID  = 'pay00001-0000-0000-0000-000000000001';
const REF         = 'PAA-2026-000001';

function createDto(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-07-26T00:00:00.000Z',
    amount: '5000',
    method: 'CASH' as const,
    ...overrides,
  };
}

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    organizationId: ORG_A,
    purchaseId: PURCHASE_ID,
    userId: USER_ID,
    date: new Date('2026-07-26'),
    reference: REF,
    amount: new Decimal('5000'),
    method: 'CASH',
    change: new Decimal('0'),
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('PaymentPurchaseService', () => {
  let service: PaymentPurchaseService;

  let prisma: {
    purchase: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    paymentPurchase: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      aggregate: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };

  beforeEach(async () => {
    const prismaMock = {
      purchase: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      paymentPurchase: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        aggregate: jest.fn(),
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
        PaymentPurchaseService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
      ],
    }).compile();

    service = module.get(PaymentPurchaseService);
    prisma = prismaMock;
    documentCounter = dcMock;
  });

  afterEach(() => jest.clearAllMocks());

  // ─── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('recalcule paidAmount/paymentStatus correctement — séquence UNPAID → PARTIAL → PAID sur paiements cumulés', async () => {
      // Premier paiement : 5000 sur un solde de 15000 → PARTIAL
      prisma.purchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });
      prisma.paymentPurchase.create.mockResolvedValueOnce(makePayment({ amount: new Decimal('5000') }));
      prisma.purchase.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      prisma.paymentPurchase.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('5000') } });
      prisma.purchase.update.mockResolvedValueOnce({});

      await service.create(ORG_A, USER_ID, PURCHASE_ID, createDto({ amount: '5000' }));

      expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
      expect(prisma.purchase.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { id: PURCHASE_ID },
          data: { paidAmount: expect.any(Decimal), paymentStatus: 'PARTIAL' },
        }),
      );
      expect(
        (prisma.purchase.update.mock.calls[0]![0] as { data: { paidAmount: Decimal } }).data.paidAmount.toString(),
      ).toBe('5000');

      // Deuxième paiement : encore 10000 → solde soldé (15000) → PAID
      prisma.purchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('5000'),
      });
      prisma.paymentPurchase.create.mockResolvedValueOnce(makePayment({ amount: new Decimal('10000') }));
      prisma.purchase.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      prisma.paymentPurchase.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('15000') } });
      prisma.purchase.update.mockResolvedValueOnce({});

      await service.create(ORG_A, USER_ID, PURCHASE_ID, createDto({ amount: '10000' }));

      expect(prisma.purchase.update).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ data: { paidAmount: expect.any(Decimal), paymentStatus: 'PAID' } }),
      );
      expect(
        (prisma.purchase.update.mock.calls[1]![0] as { data: { paidAmount: Decimal } }).data.paidAmount.toString(),
      ).toBe('15000');
    });

    it("plusieurs paiements cumulés sur le même achat → paidAmount = somme exacte (Decimal, pas d'erreur d'arrondi)", async () => {
      // Trois paiements décimaux dont la somme flottante naïve (4999.999 + 5000.001 + 5000)
      // subirait une erreur d'arrondi en IEEE-754 — Decimal.js doit rester exact.
      const amounts = ['4999.999', '5000.001', '5000'];
      let cumulative = new Decimal(0);

      for (const amount of amounts) {
        prisma.purchase.findUnique.mockResolvedValueOnce({
          organizationId: ORG_A,
          deletedAt: null,
          grandTotal: new Decimal('15000'),
          paidAmount: cumulative,
        });
        prisma.paymentPurchase.create.mockResolvedValueOnce(makePayment({ amount: new Decimal(amount) }));
        cumulative = cumulative.plus(amount);
        prisma.purchase.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
        prisma.paymentPurchase.aggregate.mockResolvedValueOnce({ _sum: { amount: cumulative } });
        prisma.purchase.update.mockResolvedValueOnce({});

        await service.create(ORG_A, USER_ID, PURCHASE_ID, createDto({ amount }));
      }

      const lastCall = prisma.purchase.update.mock.calls[2]![0] as {
        data: { paidAmount: Decimal; paymentStatus: string };
      };
      expect(lastCall.data.paidAmount.toString()).toBe('15000');
      expect(lastCall.data.paymentStatus).toBe('PAID');
    });

    it('lève BadRequestException si le montant dépasse le solde restant — Purchase inchangé', async () => {
      prisma.purchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('10000'),
      });

      await expect(
        service.create(ORG_A, USER_ID, PURCHASE_ID, createDto({ amount: '6000' })),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.paymentPurchase.create).not.toHaveBeenCalled();
      expect(prisma.purchase.update).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si l'achat appartient à une autre organisation (IDOR)", async () => {
      prisma.purchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });

      await expect(service.create(ORG_A, USER_ID, PURCHASE_ID, createDto())).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.paymentPurchase.create).not.toHaveBeenCalled();
    });

    it("lève NotFoundException si l'achat est introuvable", async () => {
      prisma.purchase.findUnique.mockResolvedValueOnce(null);

      await expect(service.create(ORG_A, USER_ID, PURCHASE_ID, createDto())).rejects.toThrow(
        NotFoundException,
      );
    });

    it("lève NotFoundException si l'achat est soft-deleted", async () => {
      prisma.purchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: new Date(),
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });

      await expect(service.create(ORG_A, USER_ID, PURCHASE_ID, createDto())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────

  describe('update', () => {
    it('recalcule correctement le solde à la hausse du montant', async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        purchaseId: PURCHASE_ID,
        amount: new Decimal('5000'),
      });
      prisma.purchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('5000'),
      });
      prisma.paymentPurchase.update.mockResolvedValueOnce(makePayment({ amount: new Decimal('10000') }));
      prisma.purchase.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      prisma.paymentPurchase.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('10000') } });
      prisma.purchase.update.mockResolvedValueOnce({});

      await service.update(PAYMENT_ID, ORG_A, { amount: '10000' });

      expect(
        (prisma.paymentPurchase.update.mock.calls[0]![0] as { data: { amount: Decimal } }).data.amount.toString(),
      ).toBe('10000');
      expect(
        (prisma.purchase.update.mock.calls[0]![0] as { data: { paidAmount: Decimal; paymentStatus: string } }).data
          .paidAmount.toString(),
      ).toBe('10000');
      expect(
        (prisma.purchase.update.mock.calls[0]![0] as { data: { paymentStatus: string } }).data.paymentStatus,
      ).toBe('PARTIAL');
    });

    it('recalcule correctement le solde à la baisse du montant', async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        purchaseId: PURCHASE_ID,
        amount: new Decimal('5000'),
      });
      prisma.purchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('10000'), // 5000 (ce paiement) + 5000 (autre paiement)
      });
      prisma.paymentPurchase.update.mockResolvedValueOnce(makePayment({ amount: new Decimal('2000') }));
      prisma.purchase.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      // Nouvelle somme réelle = 2000 (ce paiement) + 5000 (autre) = 7000
      prisma.paymentPurchase.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('7000') } });
      prisma.purchase.update.mockResolvedValueOnce({});

      await service.update(PAYMENT_ID, ORG_A, { amount: '2000' });

      expect(
        (prisma.paymentPurchase.update.mock.calls[0]![0] as { data: { amount: Decimal } }).data.amount.toString(),
      ).toBe('2000');
      expect(
        (prisma.purchase.update.mock.calls[0]![0] as { data: { paidAmount: Decimal } }).data.paidAmount.toString(),
      ).toBe('7000');
    });

    it(
      "cas limite : le nouveau montant est accepté seulement parce que l'ancien montant est " +
        'exclu du calcul du solde restant',
      async () => {
        // Achat déjà entièrement payé (paidAmount === grandTotal) via CE paiement (5000) +
        // un autre (6000). Sans exclusion de l'ancien montant, le solde apparent serait 0 et
        // toute augmentation échouerait. Avec exclusion : solde = 15000 - (11000 - 5000) = 9000,
        // donc porter ce paiement à 9000 (increase) doit être accepté.
        prisma.paymentPurchase.findUnique.mockResolvedValueOnce({
          organizationId: ORG_A,
          purchaseId: PURCHASE_ID,
          amount: new Decimal('5000'),
        });
        prisma.purchase.findUnique.mockResolvedValueOnce({
          organizationId: ORG_A,
          deletedAt: null,
          grandTotal: new Decimal('15000'),
          paidAmount: new Decimal('11000'), // 5000 (ce paiement) + 6000 (autre)
        });
        prisma.paymentPurchase.update.mockResolvedValueOnce(makePayment({ amount: new Decimal('9000') }));
        prisma.purchase.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
        prisma.paymentPurchase.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('15000') } });
        prisma.purchase.update.mockResolvedValueOnce({});

        await expect(service.update(PAYMENT_ID, ORG_A, { amount: '9000' })).resolves.toBeDefined();

        expect(
          (prisma.paymentPurchase.update.mock.calls[0]![0] as { data: { amount: Decimal } }).data.amount.toString(),
        ).toBe('9000');
        expect(
          (prisma.purchase.update.mock.calls[0]![0] as { data: { paymentStatus: string } }).data.paymentStatus,
        ).toBe('PAID');
      },
    );

    it('lève BadRequestException si le nouveau montant dépasse le solde restant (ancien montant exclu)', async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        purchaseId: PURCHASE_ID,
        amount: new Decimal('5000'),
      });
      prisma.purchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('10000'), // 5000 (ce paiement) + 5000 (autre)
      });
      // remainingExcludingThis = 15000 - (10000 - 5000) = 10000 → 12000 dépasse

      await expect(service.update(PAYMENT_ID, ORG_A, { amount: '12000' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.paymentPurchase.update).not.toHaveBeenCalled();
      expect(prisma.purchase.update).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si le paiement est introuvable', async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce(null);

      await expect(service.update(PAYMENT_ID, ORG_A, { amount: '1000' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it("lève ForbiddenException si le paiement appartient à une autre organisation (IDOR)", async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        purchaseId: PURCHASE_ID,
        amount: new Decimal('5000'),
      });

      await expect(service.update(PAYMENT_ID, ORG_A, { amount: '1000' })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('recalcule le solde après suppression — paymentStatus redescend PAID → PARTIAL', async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        purchaseId: PURCHASE_ID,
        amount: new Decimal('5000'),
      });
      prisma.paymentPurchase.delete.mockResolvedValueOnce({});
      prisma.purchase.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      // Solde restant après suppression du paiement de 5000 : 10000 (autre paiement)
      prisma.paymentPurchase.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('10000') } });
      prisma.purchase.update.mockResolvedValueOnce({});

      await service.remove(PAYMENT_ID, ORG_A);

      expect(prisma.paymentPurchase.delete).toHaveBeenCalledWith({ where: { id: PAYMENT_ID } });
      expect(
        (prisma.purchase.update.mock.calls[0]![0] as { data: { paidAmount: Decimal; paymentStatus: string } }).data
          .paymentStatus,
      ).toBe('PARTIAL');
    });

    it('recalcule le solde après suppression — paymentStatus redescend PARTIAL → UNPAID', async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        purchaseId: PURCHASE_ID,
        amount: new Decimal('5000'),
      });
      prisma.paymentPurchase.delete.mockResolvedValueOnce({});
      prisma.purchase.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      // Dernier paiement supprimé → plus aucun paiement
      prisma.paymentPurchase.aggregate.mockResolvedValueOnce({ _sum: { amount: null } });
      prisma.purchase.update.mockResolvedValueOnce({});

      await service.remove(PAYMENT_ID, ORG_A);

      const call = prisma.purchase.update.mock.calls[0]![0] as {
        data: { paidAmount: Decimal; paymentStatus: string };
      };
      expect(call.data.paidAmount.toString()).toBe('0');
      expect(call.data.paymentStatus).toBe('UNPAID');
    });

    it('lève NotFoundException si le paiement est introuvable', async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce(null);

      await expect(service.remove(PAYMENT_ID, ORG_A)).rejects.toThrow(NotFoundException);
      expect(prisma.paymentPurchase.delete).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si le paiement appartient à une autre organisation (IDOR)", async () => {
      prisma.paymentPurchase.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        purchaseId: PURCHASE_ID,
        amount: new Decimal('5000'),
      });

      await expect(service.remove(PAYMENT_ID, ORG_A)).rejects.toThrow(ForbiddenException);
      expect(prisma.paymentPurchase.delete).not.toHaveBeenCalled();
    });
  });
});
