import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Decimal } from '@prisma/client/runtime/library';
import { PaymentSaleService } from '../payment-sale.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A       = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B       = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID     = 'user0000-0000-0000-0000-000000000001';
const SALE_ID     = 'sale0001-0000-0000-0000-000000000001';
const PAYMENT_ID  = 'pay00001-0000-0000-0000-000000000001';
const REF         = 'PAY-2026-000001';

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
    saleId: SALE_ID,
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

describe('PaymentSaleService', () => {
  let service: PaymentSaleService;

  let prisma: {
    sale: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    paymentSale: {
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
  let emailQueue: { add: jest.Mock };

  beforeEach(async () => {
    const prismaMock = {
      sale: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      paymentSale: {
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
    const emailQueueMock = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PaymentSaleService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
        { provide: getQueueToken('email'), useValue: emailQueueMock },
      ],
    }).compile();

    service = module.get(PaymentSaleService);
    prisma = prismaMock;
    documentCounter = dcMock;
    emailQueue = emailQueueMock;
  });

  afterEach(() => jest.clearAllMocks());

  // ─── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('recalcule paidAmount/paymentStatus correctement — séquence UNPAID → PARTIAL → PAID sur paiements cumulés', async () => {
      // Premier paiement : 5000 sur un solde de 15000 → PARTIAL
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });
      prisma.paymentSale.create.mockResolvedValueOnce(makePayment({ amount: new Decimal('5000') }));
      prisma.sale.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      prisma.paymentSale.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('5000') } });
      prisma.sale.update.mockResolvedValueOnce({});

      await service.create(ORG_A, USER_ID, SALE_ID, createDto({ amount: '5000' }));

      expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
      expect(prisma.sale.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { id: SALE_ID },
          data: { paidAmount: expect.any(Decimal), paymentStatus: 'PARTIAL' },
        }),
      );
      expect(
        (prisma.sale.update.mock.calls[0]![0] as { data: { paidAmount: Decimal } }).data.paidAmount.toString(),
      ).toBe('5000');

      // Deuxième paiement : encore 10000 → solde soldé (15000) → PAID
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('5000'),
      });
      prisma.paymentSale.create.mockResolvedValueOnce(makePayment({ amount: new Decimal('10000') }));
      prisma.sale.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      prisma.paymentSale.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('15000') } });
      prisma.sale.update.mockResolvedValueOnce({});

      await service.create(ORG_A, USER_ID, SALE_ID, createDto({ amount: '10000' }));

      expect(prisma.sale.update).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ data: { paidAmount: expect.any(Decimal), paymentStatus: 'PAID' } }),
      );
      expect(
        (prisma.sale.update.mock.calls[1]![0] as { data: { paidAmount: Decimal } }).data.paidAmount.toString(),
      ).toBe('15000');
    });

    it("plusieurs paiements cumulés sur la même vente → paidAmount = somme exacte (Decimal, pas d'erreur d'arrondi)", async () => {
      // Trois paiements décimaux dont la somme flottante naïve (4999.999 + 5000.001 + 5000)
      // subirait une erreur d'arrondi en IEEE-754 — Decimal.js doit rester exact.
      const amounts = ['4999.999', '5000.001', '5000'];
      let cumulative = new Decimal(0);

      for (const amount of amounts) {
        prisma.sale.findUnique.mockResolvedValueOnce({
          organizationId: ORG_A,
          deletedAt: null,
          grandTotal: new Decimal('15000'),
          paidAmount: cumulative,
        });
        prisma.paymentSale.create.mockResolvedValueOnce(makePayment({ amount: new Decimal(amount) }));
        cumulative = cumulative.plus(amount);
        prisma.sale.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
        prisma.paymentSale.aggregate.mockResolvedValueOnce({ _sum: { amount: cumulative } });
        prisma.sale.update.mockResolvedValueOnce({});

        await service.create(ORG_A, USER_ID, SALE_ID, createDto({ amount }));
      }

      const lastCall = prisma.sale.update.mock.calls[2]![0] as {
        data: { paidAmount: Decimal; paymentStatus: string };
      };
      expect(lastCall.data.paidAmount.toString()).toBe('15000');
      expect(lastCall.data.paymentStatus).toBe('PAID');
    });

    it('lève BadRequestException si le montant dépasse le solde restant — Sale inchangée', async () => {
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('10000'),
      });

      await expect(
        service.create(ORG_A, USER_ID, SALE_ID, createDto({ amount: '6000' })),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.paymentSale.create).not.toHaveBeenCalled();
      expect(prisma.sale.update).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si la vente appartient à une autre organisation", async () => {
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });

      await expect(service.create(ORG_A, USER_ID, SALE_ID, createDto())).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.paymentSale.create).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si la vente est introuvable', async () => {
      prisma.sale.findUnique.mockResolvedValueOnce(null);

      await expect(service.create(ORG_A, USER_ID, SALE_ID, createDto())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lève NotFoundException si la vente est soft-deleted', async () => {
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: new Date(),
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });

      await expect(service.create(ORG_A, USER_ID, SALE_ID, createDto())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────

  describe('update', () => {
    it('recalcule correctement le solde à la hausse du montant', async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('5000'),
      });
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('5000'),
      });
      prisma.paymentSale.update.mockResolvedValueOnce(makePayment({ amount: new Decimal('10000') }));
      prisma.sale.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      prisma.paymentSale.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('10000') } });
      prisma.sale.update.mockResolvedValueOnce({});

      await service.update(PAYMENT_ID, ORG_A, { amount: '10000' });

      expect(
        (prisma.paymentSale.update.mock.calls[0]![0] as { data: { amount: Decimal } }).data.amount.toString(),
      ).toBe('10000');
      expect(
        (prisma.sale.update.mock.calls[0]![0] as { data: { paidAmount: Decimal; paymentStatus: string } }).data
          .paidAmount.toString(),
      ).toBe('10000');
      expect(
        (prisma.sale.update.mock.calls[0]![0] as { data: { paymentStatus: string } }).data.paymentStatus,
      ).toBe('PARTIAL');
    });

    it('recalcule correctement le solde à la baisse du montant', async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('5000'),
      });
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('10000'), // 5000 (ce paiement) + 5000 (autre paiement)
      });
      prisma.paymentSale.update.mockResolvedValueOnce(makePayment({ amount: new Decimal('2000') }));
      prisma.sale.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      // Nouvelle somme réelle = 2000 (ce paiement) + 5000 (autre) = 7000
      prisma.paymentSale.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('7000') } });
      prisma.sale.update.mockResolvedValueOnce({});

      await service.update(PAYMENT_ID, ORG_A, { amount: '2000' });

      expect(
        (prisma.paymentSale.update.mock.calls[0]![0] as { data: { amount: Decimal } }).data.amount.toString(),
      ).toBe('2000');
      expect(
        (prisma.sale.update.mock.calls[0]![0] as { data: { paidAmount: Decimal } }).data.paidAmount.toString(),
      ).toBe('7000');
    });

    it(
      "cas limite : le nouveau montant est accepté seulement parce que l'ancien montant est " +
        'exclu du calcul du solde restant',
      async () => {
        // Vente déjà entièrement payée (paidAmount === grandTotal) via CE paiement (5000) +
        // un autre (6000). Sans exclusion de l'ancien montant, le solde apparent serait 0 et
        // toute augmentation échouerait. Avec exclusion : solde = 15000 - (11000 - 5000) = 9000,
        // donc porter ce paiement à 9000 (increase) doit être accepté.
        prisma.paymentSale.findUnique.mockResolvedValueOnce({
          organizationId: ORG_A,
          saleId: SALE_ID,
          amount: new Decimal('5000'),
        });
        prisma.sale.findUnique.mockResolvedValueOnce({
          organizationId: ORG_A,
          deletedAt: null,
          grandTotal: new Decimal('15000'),
          paidAmount: new Decimal('11000'), // 5000 (ce paiement) + 6000 (autre)
        });
        prisma.paymentSale.update.mockResolvedValueOnce(makePayment({ amount: new Decimal('9000') }));
        prisma.sale.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
        prisma.paymentSale.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('15000') } });
        prisma.sale.update.mockResolvedValueOnce({});

        await expect(service.update(PAYMENT_ID, ORG_A, { amount: '9000' })).resolves.toBeDefined();

        expect(
          (prisma.paymentSale.update.mock.calls[0]![0] as { data: { amount: Decimal } }).data.amount.toString(),
        ).toBe('9000');
        expect(
          (prisma.sale.update.mock.calls[0]![0] as { data: { paymentStatus: string } }).data.paymentStatus,
        ).toBe('PAID');
      },
    );

    it('lève BadRequestException si le nouveau montant dépasse le solde restant (ancien montant exclu)', async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('5000'),
      });
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('10000'), // 5000 (ce paiement) + 5000 (autre)
      });
      // remainingExcludingThis = 15000 - (10000 - 5000) = 10000 → 12000 dépasse

      await expect(service.update(PAYMENT_ID, ORG_A, { amount: '12000' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.paymentSale.update).not.toHaveBeenCalled();
      expect(prisma.sale.update).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si le paiement est introuvable', async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce(null);

      await expect(service.update(PAYMENT_ID, ORG_A, { amount: '1000' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it("lève ForbiddenException si le paiement appartient à une autre organisation", async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        saleId: SALE_ID,
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
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('5000'),
      });
      prisma.paymentSale.delete.mockResolvedValueOnce({});
      prisma.sale.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      // Solde restant après suppression du paiement de 5000 : 10000 (autre paiement)
      prisma.paymentSale.aggregate.mockResolvedValueOnce({ _sum: { amount: new Decimal('10000') } });
      prisma.sale.update.mockResolvedValueOnce({});

      await service.remove(PAYMENT_ID, ORG_A);

      expect(prisma.paymentSale.delete).toHaveBeenCalledWith({ where: { id: PAYMENT_ID } });
      expect(
        (prisma.sale.update.mock.calls[0]![0] as { data: { paidAmount: Decimal; paymentStatus: string } }).data
          .paymentStatus,
      ).toBe('PARTIAL');
    });

    it('recalcule le solde après suppression — paymentStatus redescend PARTIAL → UNPAID', async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('5000'),
      });
      prisma.paymentSale.delete.mockResolvedValueOnce({});
      prisma.sale.findUniqueOrThrow.mockResolvedValueOnce({ grandTotal: new Decimal('15000') });
      // Dernier paiement supprimé → plus aucun paiement
      prisma.paymentSale.aggregate.mockResolvedValueOnce({ _sum: { amount: null } });
      prisma.sale.update.mockResolvedValueOnce({});

      await service.remove(PAYMENT_ID, ORG_A);

      const call = prisma.sale.update.mock.calls[0]![0] as {
        data: { paidAmount: Decimal; paymentStatus: string };
      };
      expect(call.data.paidAmount.toString()).toBe('0');
      expect(call.data.paymentStatus).toBe('UNPAID');
    });

    it('lève NotFoundException si le paiement est introuvable', async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce(null);

      await expect(service.remove(PAYMENT_ID, ORG_A)).rejects.toThrow(NotFoundException);
      expect(prisma.paymentSale.delete).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si le paiement appartient à une autre organisation", async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        saleId: SALE_ID,
        amount: new Decimal('5000'),
      });

      await expect(service.remove(PAYMENT_ID, ORG_A)).rejects.toThrow(ForbiddenException);
      expect(prisma.paymentSale.delete).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('enfile un job paymentSale.sendEmail sur la file email quand le client a un email', async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        sale: { client: { email: 'client@example.com' } },
      });

      const result = await service.send(PAYMENT_ID, ORG_A);

      expect(result).toEqual({ status: 'queued' });
      expect(emailQueue.add).toHaveBeenCalledWith('paymentSale.sendEmail', {
        organizationId: ORG_A,
        paymentId: PAYMENT_ID,
        to: 'client@example.com',
      });
    });

    it("lève BadRequestException si le client n'a pas d'adresse email", async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        sale: { client: { email: null } },
      });

      await expect(service.send(PAYMENT_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si le paiement est introuvable', async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce(null);

      await expect(service.send(PAYMENT_ID, ORG_A)).rejects.toThrow(NotFoundException);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si le paiement appartient à une autre organisation (anti-IDOR)", async () => {
      prisma.paymentSale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        sale: { client: { email: 'client@example.com' } },
      });

      await expect(service.send(PAYMENT_ID, ORG_A)).rejects.toThrow(ForbiddenException);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });
  });
});
