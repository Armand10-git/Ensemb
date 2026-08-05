import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { PaymentReturnService } from '../payment-return.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A             = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B             = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID            = 'user0000-0000-0000-0000-000000000001';
const SALE_RETURN_ID     = 'sret0001-0000-0000-0000-000000000001';
const PURCHASE_RETURN_ID = 'pret0001-0000-0000-0000-000000000001';
const PAYMENT_ID         = 'pay00001-0000-0000-0000-000000000001';
const REF                = 'REM-2026-000001';

function createDto(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-07-26T00:00:00.000Z',
    amount: '2000',
    method: 'CASH' as const,
    ...overrides,
  };
}

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    organizationId: ORG_A,
    saleReturnId: null,
    purchaseReturnId: null,
    userId: USER_ID,
    date: new Date('2026-07-26'),
    reference: REF,
    amount: new Decimal('2000'),
    method: 'CASH',
    change: new Decimal('0'),
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PaymentReturnService', () => {
  let service: PaymentReturnService;

  let prisma: {
    saleReturn: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock };
    purchaseReturn: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock };
    paymentReturn: {
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
      saleReturn: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
      purchaseReturn: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
      paymentReturn: {
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
        PaymentReturnService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
      ],
    }).compile();

    service = module.get(PaymentReturnService);
    prisma = prismaMock;
    documentCounter = dcMock;
  });

  afterEach(() => jest.clearAllMocks());

  // ─── createForSaleReturn ───────────────────────────────────────────────────

  describe('createForSaleReturn', () => {
    it('pose purchaseReturnId=null explicitement (jamais undefined) et recalcule paidAmount/paymentStatus', async () => {
      prisma.saleReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('0'),
      });
      prisma.paymentReturn.create.mockResolvedValueOnce(makePayment({ saleReturnId: SALE_RETURN_ID }));
      prisma.saleReturn.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('5000') });
      prisma.paymentReturn.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('2000') } });
      prisma.saleReturn.update.mockResolvedValueOnce({});

      await service.createForSaleReturn(ORG_A, USER_ID, SALE_RETURN_ID, createDto());

      expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
      const createArgs = prisma.paymentReturn.create.mock.calls[0][0] as {
        data: { saleReturnId: string; purchaseReturnId: string | null };
      };
      expect(createArgs.data.saleReturnId).toBe(SALE_RETURN_ID);
      expect(createArgs.data.purchaseReturnId).toBeNull();
      expect(prisma.saleReturn.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SALE_RETURN_ID }, data: { paidAmount: expect.any(Decimal), paymentStatus: 'PARTIAL' } }),
      );
    });

    it('lève BadRequestException si le montant dépasse le solde restant — aucune écriture', async () => {
      prisma.saleReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('4000'),
      });

      await expect(
        service.createForSaleReturn(ORG_A, USER_ID, SALE_RETURN_ID, createDto({ amount: '2000' })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.paymentReturn.create).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si le retour de vente appartient à une autre organisation", async () => {
      prisma.saleReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('0'),
      });

      await expect(
        service.createForSaleReturn(ORG_A, USER_ID, SALE_RETURN_ID, createDto()),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si le retour de vente est introuvable', async () => {
      prisma.saleReturn.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.createForSaleReturn(ORG_A, USER_ID, SALE_RETURN_ID, createDto()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── createForPurchaseReturn ────────────────────────────────────────────────

  describe('createForPurchaseReturn', () => {
    it('pose saleReturnId=null explicitement (jamais undefined) et recalcule paidAmount/paymentStatus', async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('0'),
      });
      prisma.paymentReturn.create.mockResolvedValueOnce(makePayment({ purchaseReturnId: PURCHASE_RETURN_ID }));
      prisma.purchaseReturn.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('5000') });
      prisma.paymentReturn.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('5000') } });
      prisma.purchaseReturn.update.mockResolvedValueOnce({});

      await service.createForPurchaseReturn(ORG_A, USER_ID, PURCHASE_RETURN_ID, createDto({ amount: '5000' }));

      const createArgs = prisma.paymentReturn.create.mock.calls[0][0] as {
        data: { saleReturnId: string | null; purchaseReturnId: string };
      };
      expect(createArgs.data.saleReturnId).toBeNull();
      expect(createArgs.data.purchaseReturnId).toBe(PURCHASE_RETURN_ID);
      expect(prisma.purchaseReturn.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { paidAmount: expect.any(Decimal), paymentStatus: 'PAID' } }),
      );
    });

    it('lève BadRequestException si le montant dépasse le solde restant du retour fournisseur', async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('4500'),
      });

      await expect(
        service.createForPurchaseReturn(ORG_A, USER_ID, PURCHASE_RETURN_ID, createDto({ amount: '600' })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.paymentReturn.create).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si le retour fournisseur appartient à une autre organisation", async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('0'),
      });

      await expect(
        service.createForPurchaseReturn(ORG_A, USER_ID, PURCHASE_RETURN_ID, createDto()),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────

  describe('update', () => {
    it('relit le parent SaleReturn depuis les FK existants du paiement — jamais depuis le DTO (qui n\'en contient aucun)', async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleReturnId: SALE_RETURN_ID,
        purchaseReturnId: null,
        amount: new Decimal('2000'),
      });
      prisma.saleReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('2000'),
      });
      prisma.paymentReturn.update.mockResolvedValueOnce(makePayment({ saleReturnId: SALE_RETURN_ID, amount: new Decimal('3000') }));
      prisma.saleReturn.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('5000') });
      prisma.paymentReturn.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('3000') } });
      prisma.saleReturn.update.mockResolvedValueOnce({});

      await service.update(PAYMENT_ID, ORG_A, { amount: '3000' });

      // Le parent utilisé est bien saleReturn (jamais purchaseReturn), déterminé depuis la FK
      // non-null du paiement existant — le DTO d'update ne contient aucun champ de parent.
      expect(prisma.saleReturn.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.purchaseReturn.findUnique).not.toHaveBeenCalled();
      expect(prisma.saleReturn.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SALE_RETURN_ID } }),
      );
    });

    it('relit le parent PurchaseReturn depuis les FK existants du paiement quand purchaseReturnId est non-null', async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleReturnId: null,
        purchaseReturnId: PURCHASE_RETURN_ID,
        amount: new Decimal('2000'),
      });
      prisma.purchaseReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('2000'),
      });
      prisma.paymentReturn.update.mockResolvedValueOnce(makePayment({ purchaseReturnId: PURCHASE_RETURN_ID, amount: new Decimal('1000') }));
      prisma.purchaseReturn.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('5000') });
      prisma.paymentReturn.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('1000') } });
      prisma.purchaseReturn.update.mockResolvedValueOnce({});

      await service.update(PAYMENT_ID, ORG_A, { amount: '1000' });

      expect(prisma.purchaseReturn.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.saleReturn.findUnique).not.toHaveBeenCalled();
    });

    it('lève BadRequestException si le nouveau montant dépasse le solde restant (ancien montant exclu)', async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleReturnId: SALE_RETURN_ID,
        purchaseReturnId: null,
        amount: new Decimal('2000'),
      });
      prisma.saleReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('5000'),
        paidAmount: new Decimal('4000'), // 2000 (ce paiement) + 2000 (autre)
      });
      // remainingExcludingThis = 5000 - (4000 - 2000) = 3000 → 3500 dépasse

      await expect(service.update(PAYMENT_ID, ORG_A, { amount: '3500' })).rejects.toThrow(BadRequestException);
      expect(prisma.paymentReturn.update).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si le paiement est introuvable', async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce(null);

      await expect(service.update(PAYMENT_ID, ORG_A, { amount: '1000' })).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si le paiement appartient à une autre organisation", async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        saleReturnId: SALE_RETURN_ID,
        purchaseReturnId: null,
        amount: new Decimal('2000'),
      });

      await expect(service.update(PAYMENT_ID, ORG_A, { amount: '1000' })).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('redescend PAID → PARTIAL après suppression', async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleReturnId: SALE_RETURN_ID,
        purchaseReturnId: null,
        amount: new Decimal('2000'),
      });
      prisma.paymentReturn.delete.mockResolvedValueOnce({});
      prisma.saleReturn.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('5000') });
      prisma.paymentReturn.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('3000') } });
      prisma.saleReturn.update.mockResolvedValueOnce({});

      await service.remove(PAYMENT_ID, ORG_A);

      expect(prisma.paymentReturn.delete).toHaveBeenCalledWith({ where: { id: PAYMENT_ID } });
      const call = prisma.saleReturn.update.mock.calls[0]![0] as { data: { paymentStatus: string } };
      expect(call.data.paymentStatus).toBe('PARTIAL');
    });

    it('redescend PARTIAL → UNPAID après suppression du dernier paiement (paidAmount = 0)', async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleReturnId: null,
        purchaseReturnId: PURCHASE_RETURN_ID,
        amount: new Decimal('2000'),
      });
      prisma.paymentReturn.delete.mockResolvedValueOnce({});
      prisma.purchaseReturn.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('5000') });
      prisma.paymentReturn.aggregate.mockResolvedValueOnce({ _sum: { amount: null } });
      prisma.purchaseReturn.update.mockResolvedValueOnce({});

      await service.remove(PAYMENT_ID, ORG_A);

      const call = prisma.purchaseReturn.update.mock.calls[0]![0] as {
        data: { paidAmount: Decimal; paymentStatus: string };
      };
      expect(call.data.paidAmount.toString()).toBe('0');
      expect(call.data.paymentStatus).toBe('UNPAID');
    });

    it('lève NotFoundException si le paiement est introuvable', async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce(null);

      await expect(service.remove(PAYMENT_ID, ORG_A)).rejects.toThrow(NotFoundException);
      expect(prisma.paymentReturn.delete).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si le paiement appartient à une autre organisation", async () => {
      prisma.paymentReturn.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        saleReturnId: SALE_RETURN_ID,
        purchaseReturnId: null,
        amount: new Decimal('2000'),
      });

      await expect(service.remove(PAYMENT_ID, ORG_A)).rejects.toThrow(ForbiddenException);
      expect(prisma.paymentReturn.delete).not.toHaveBeenCalled();
    });
  });
});
