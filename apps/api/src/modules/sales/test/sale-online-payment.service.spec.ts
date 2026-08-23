import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { SaleOnlinePaymentService } from '../sale-online-payment.service';
import { PrismaService } from '../../../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { PaymentSaleService } from '../payment-sale.service';
import { AsyncPaymentService } from '../../payment-gateway/async-payment.service';
import { getQueueToken } from '@nestjs/bullmq';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B = 'bbbb0000-0000-0000-0000-000000000002';
const SALE_ID = 'sale0001-0000-0000-0000-000000000001';
const USER_ID = 'user0000-0000-0000-0000-000000000001';
const CLIENT_ID = 'clie0001-0000-0000-0000-000000000001';
const INTENT_ID = 'inte0001-0000-0000-0000-000000000001';
const PAYMENT_ID = 'pay00001-0000-0000-0000-000000000001';
const QUEUE_NAME = 'sale-online-payment-expiration';

function makeConfirmation(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'CARD' as const,
    providerCustomerId: 'cust-123',
    providerTransactionId: 'txn-456',
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('SaleOnlinePaymentService', () => {
  let service: SaleOnlinePaymentService;

  let prisma: {
    sale: { findUnique: jest.Mock };
    onlinePaymentIntent: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    paymentWithCreditCard: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let config: { get: jest.Mock };
  let realtimeGateway: { server: { to: jest.Mock } };
  let emitMock: jest.Mock;
  let paymentSaleService: { createInTransaction: jest.Mock };
  let asyncPaymentService: { generatePaymentLinkFor: jest.Mock };
  let expirationQueue: { add: jest.Mock };

  beforeEach(async () => {
    const prismaMock = {
      sale: { findUnique: jest.fn() },
      onlinePaymentIntent: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      paymentWithCreditCard: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)(prismaMock);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });

    const configMock = { get: jest.fn().mockReturnValue(undefined) };

    emitMock = jest.fn();
    const toMock = jest.fn().mockReturnValue({ emit: emitMock });
    const realtimeMock = { server: { to: toMock } };

    const paymentSaleMock = { createInTransaction: jest.fn() };
    const asyncPaymentMock = { generatePaymentLinkFor: jest.fn() };
    const queueMock = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        SaleOnlinePaymentService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: configMock },
        { provide: RealtimeGateway, useValue: realtimeMock },
        { provide: PaymentSaleService, useValue: paymentSaleMock },
        { provide: AsyncPaymentService, useValue: asyncPaymentMock },
        { provide: getQueueToken(QUEUE_NAME), useValue: queueMock },
      ],
    }).compile();

    service = module.get(SaleOnlinePaymentService);
    prisma = prismaMock;
    config = configMock;
    realtimeGateway = realtimeMock;
    paymentSaleService = paymentSaleMock;
    asyncPaymentService = asyncPaymentMock;
    expirationQueue = queueMock;
  });

  afterEach(() => jest.clearAllMocks());

  // ─── initiate ────────────────────────────────────────────────────────────

  describe('initiate', () => {
    it("crée l'intention PENDING, génère le lien, enfile le job d'expiration et retourne intentId/paymentLink/expiresAt", async () => {
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('5000'),
      });
      const expiresAt = new Date('2026-08-13T12:15:00.000Z');
      prisma.onlinePaymentIntent.create.mockResolvedValueOnce({ id: INTENT_ID, expiresAt });
      asyncPaymentService.generatePaymentLinkFor.mockResolvedValueOnce('https://agg.example/pay/xyz');

      const result = await service.initiate(ORG_A, SALE_ID, '10000');

      expect(prisma.onlinePaymentIntent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: ORG_A,
            saleId: SALE_ID,
            status: 'PENDING',
          }),
        }),
      );
      expect(asyncPaymentService.generatePaymentLinkFor).toHaveBeenCalledWith(ORG_A, {
        amount: expect.any(Decimal),
        currency: 'XAF',
        reference: INTENT_ID,
        callbackPath: ORG_A,
      });
      expect(expirationQueue.add).toHaveBeenCalledWith(
        'sale.expireOnlinePayment',
        { intentId: INTENT_ID, organizationId: ORG_A },
        { delay: expect.any(Number) },
      );
      expect(result).toEqual({
        intentId: INTENT_ID,
        paymentLink: 'https://agg.example/pay/xyz',
        expiresAt,
      });
    });

    it('utilise le timeout par défaut (900000 ms) si SALE_ONLINE_PAYMENT_TIMEOUT_MS non configuré', async () => {
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });
      prisma.onlinePaymentIntent.create.mockResolvedValueOnce({
        id: INTENT_ID,
        expiresAt: new Date(),
      });
      asyncPaymentService.generatePaymentLinkFor.mockResolvedValueOnce('https://agg.example/pay/xyz');
      config.get.mockReturnValue(undefined);

      await service.initiate(ORG_A, SALE_ID, '1000');

      expect(expirationQueue.add).toHaveBeenCalledWith(
        'sale.expireOnlinePayment',
        expect.anything(),
        { delay: 900_000 },
      );
    });

    it('lève BadRequestException si le montant dépasse le solde restant — aucune intention créée', async () => {
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('10000'),
      });

      await expect(service.initiate(ORG_A, SALE_ID, '6000')).rejects.toThrow(BadRequestException);

      expect(prisma.onlinePaymentIntent.create).not.toHaveBeenCalled();
      expect(asyncPaymentService.generatePaymentLinkFor).not.toHaveBeenCalled();
      expect(expirationQueue.add).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si la vente est introuvable', async () => {
      prisma.sale.findUnique.mockResolvedValueOnce(null);

      await expect(service.initiate(ORG_A, SALE_ID, '1000')).rejects.toThrow(NotFoundException);
    });

    it('lève NotFoundException si la vente est soft-deleted', async () => {
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        deletedAt: new Date(),
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });

      await expect(service.initiate(ORG_A, SALE_ID, '1000')).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si la vente appartient à une autre organisation", async () => {
      prisma.sale.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        deletedAt: null,
        grandTotal: new Decimal('15000'),
        paidAmount: new Decimal('0'),
      });

      await expect(service.initiate(ORG_A, SALE_ID, '1000')).rejects.toThrow(ForbiddenException);
      expect(prisma.onlinePaymentIntent.create).not.toHaveBeenCalled();
    });
  });

  // ─── confirmPayment ──────────────────────────────────────────────────────

  describe('confirmPayment', () => {
    it('crée PaymentSale + PaymentWithCreditCard, passe CONFIRMED et émet sale:updated', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        id: INTENT_ID,
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('10000'),
        status: 'PENDING',
      });
      prisma.sale.findUnique.mockResolvedValueOnce({ userId: USER_ID, clientId: CLIENT_ID });
      paymentSaleService.createInTransaction.mockResolvedValueOnce({ id: PAYMENT_ID });
      prisma.paymentWithCreditCard.create.mockResolvedValueOnce({});
      prisma.onlinePaymentIntent.update.mockResolvedValueOnce({});

      await service.confirmPayment(ORG_A, INTENT_ID, makeConfirmation());

      expect(paymentSaleService.createInTransaction).toHaveBeenCalledWith(
        prisma,
        ORG_A,
        USER_ID,
        SALE_ID,
        expect.objectContaining({ amount: '10000', method: 'CARD', change: '0' }),
      );
      expect(prisma.paymentWithCreditCard.create).toHaveBeenCalledWith({
        data: {
          paymentSaleId: PAYMENT_ID,
          organizationId: ORG_A,
          customerId: CLIENT_ID,
          provider: 'CARD',
          providerCustomerId: 'cust-123',
          providerTransactionId: 'txn-456',
        },
      });
      expect(prisma.onlinePaymentIntent.update).toHaveBeenCalledWith({
        where: { id: INTENT_ID },
        data: { status: 'CONFIRMED', paymentSaleId: PAYMENT_ID },
      });
      expect(realtimeGateway.server.to).toHaveBeenCalledWith(`org:${ORG_A}`);
      expect(emitMock).toHaveBeenCalledWith('sale:updated', { saleId: SALE_ID });
    });

    it('no-op idempotent si l\'intention est introuvable — aucune écriture, aucun événement', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce(null);

      await service.confirmPayment(ORG_A, INTENT_ID, makeConfirmation());

      expect(paymentSaleService.createInTransaction).not.toHaveBeenCalled();
      expect(prisma.paymentWithCreditCard.create).not.toHaveBeenCalled();
      expect(prisma.onlinePaymentIntent.update).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it("no-op idempotent si l'intention appartient à une autre organisation", async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        id: INTENT_ID,
        organizationId: ORG_B,
        saleId: SALE_ID,
        amount: new Decimal('10000'),
        status: 'PENDING',
      });

      await service.confirmPayment(ORG_A, INTENT_ID, makeConfirmation());

      expect(paymentSaleService.createInTransaction).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('no-op idempotent si déjà CONFIRMED — pas de double PaymentSale', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        id: INTENT_ID,
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('10000'),
        status: 'CONFIRMED',
      });

      await service.confirmPayment(ORG_A, INTENT_ID, makeConfirmation());

      expect(paymentSaleService.createInTransaction).not.toHaveBeenCalled();
      expect(prisma.paymentWithCreditCard.create).not.toHaveBeenCalled();
      expect(prisma.onlinePaymentIntent.update).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('no-op idempotent si déjà EXPIRED — pas de PaymentSale créé', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        id: INTENT_ID,
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('10000'),
        status: 'EXPIRED',
      });

      await service.confirmPayment(ORG_A, INTENT_ID, makeConfirmation());

      expect(paymentSaleService.createInTransaction).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it(
      'BadRequestException de PaymentSaleService.createInTransaction (solde dépassé — remboursement ' +
        'concurrent) → ne crée rien, ne lève pas, réconciliation manuelle journalisée',
      async () => {
        prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
          id: INTENT_ID,
          organizationId: ORG_A,
          saleId: SALE_ID,
          amount: new Decimal('10000'),
          status: 'PENDING',
        });
        prisma.sale.findUnique.mockResolvedValueOnce({ userId: USER_ID, clientId: CLIENT_ID });
        paymentSaleService.createInTransaction.mockRejectedValueOnce(
          new BadRequestException('Le montant dépasse le solde restant (0.000).'),
        );

        await expect(
          service.confirmPayment(ORG_A, INTENT_ID, makeConfirmation()),
        ).resolves.toBeUndefined();

        expect(prisma.paymentWithCreditCard.create).not.toHaveBeenCalled();
        expect(prisma.onlinePaymentIntent.update).not.toHaveBeenCalled();
        expect(emitMock).not.toHaveBeenCalled();
      },
    );

    it('propage une erreur inattendue (hors BadRequestException) de createInTransaction', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        id: INTENT_ID,
        organizationId: ORG_A,
        saleId: SALE_ID,
        amount: new Decimal('10000'),
        status: 'PENDING',
      });
      prisma.sale.findUnique.mockResolvedValueOnce({ userId: USER_ID, clientId: CLIENT_ID });
      paymentSaleService.createInTransaction.mockRejectedValueOnce(new Error('DB indisponible'));

      await expect(service.confirmPayment(ORG_A, INTENT_ID, makeConfirmation())).rejects.toThrow(
        'DB indisponible',
      );
    });
  });

  // ─── expirePayment ───────────────────────────────────────────────────────

  describe('expirePayment', () => {
    it('passe PENDING → EXPIRED sans toucher Sale ni le stock', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        status: 'PENDING',
      });
      prisma.onlinePaymentIntent.update.mockResolvedValueOnce({});

      await service.expirePayment(ORG_A, INTENT_ID);

      expect(prisma.onlinePaymentIntent.update).toHaveBeenCalledWith({
        where: { id: INTENT_ID },
        data: { status: 'EXPIRED' },
      });
      // Aucun appel de restitution/mise à jour de Sale — le stock d'une vente classique est
      // découplé de l'encaissement (décrémenté à validate(), S21), et Sale.status n'est
      // jamais un flux affecté par ce worker (§17 règle 7).
      expect(prisma.sale.findUnique).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('no-op idempotent si déjà CONFIRMED', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        status: 'CONFIRMED',
      });

      await service.expirePayment(ORG_A, INTENT_ID);

      expect(prisma.onlinePaymentIntent.update).not.toHaveBeenCalled();
    });

    it('no-op idempotent si déjà EXPIRED', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        organizationId: ORG_A,
        status: 'EXPIRED',
      });

      await service.expirePayment(ORG_A, INTENT_ID);

      expect(prisma.onlinePaymentIntent.update).not.toHaveBeenCalled();
    });

    it('no-op idempotent si l\'intention est introuvable', async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce(null);

      await service.expirePayment(ORG_A, INTENT_ID);

      expect(prisma.onlinePaymentIntent.update).not.toHaveBeenCalled();
    });

    it("no-op idempotent si l'intention appartient à une autre organisation", async () => {
      prisma.onlinePaymentIntent.findUnique.mockResolvedValueOnce({
        organizationId: ORG_B,
        status: 'PENDING',
      });

      await service.expirePayment(ORG_A, INTENT_ID);

      expect(prisma.onlinePaymentIntent.update).not.toHaveBeenCalled();
    });
  });
});
