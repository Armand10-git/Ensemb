import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PosService } from '../pos.service';
import { OptimisticLockException } from '../../inventory/product-warehouse.service';
import type { CreatePosSaleDto } from '../dto/pos-sale.dto';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A     = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B     = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID   = 'user0000-0000-0000-0000-000000000001';
const CLIENT_ID = 'client01-0000-0000-0000-000000000001';
const WH_ID     = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID   = 'prod0000-0000-0000-0000-000000000001';
const SALE_ID   = 'sale0001-0000-0000-0000-000000000001';
const PW_ID     = 'pw000001-0000-0000-0000-000000000001';
const REF       = 'VTE-2026-000001';
const CASH_SESSION_ID  = 'cs000001-0000-0000-0000-000000000001';
const CASH_SESSION_REF = 'CS-2026-000001';

function makeCreatedSale(overrides: Record<string, unknown> = {}) {
  return {
    id: SALE_ID,
    organizationId: ORG_A,
    reference: REF,
    date: new Date('2026-07-27'),
    isPos: true,
    userId: USER_ID,
    clientId: CLIENT_ID,
    warehouseId: WH_ID,
    taxRate: new Decimal('0'),
    taxAmount: new Decimal('0'),
    discount: new Decimal('0'),
    shipping: new Decimal('0'),
    grandTotal: new Decimal('2000'),
    paidAmount: new Decimal('0'),
    paymentStatus: 'UNPAID',
    status: 'COMPLETED',
    notes: null,
    cancelReason: null,
    cancelledAt: null,
    cancelledById: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    details: [],
    ...overrides,
  };
}

function baseDto(overrides: Record<string, unknown> = {}): CreatePosSaleDto {
  return {
    clientId: CLIENT_ID,
    warehouseId: WH_ID,
    details: [{ productId: PROD_ID, price: '1000', quantity: '2' }],
    paymentMethod: 'CASH',
    amountReceived: '2000',
    ...overrides,
  } as CreatePosSaleDto;
}

describe('PosService', () => {
  let service: PosService;

  let prisma: {
    client: { findUnique: jest.Mock };
    warehouse: { findUnique: jest.Mock };
    product: { findMany: jest.Mock };
    productVariant: { findMany: jest.Mock };
    unit: { findMany: jest.Mock };
    productWarehouse: { findFirst: jest.Mock };
    sale: { create: jest.Mock; findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };

  let productWarehouseService: { adjustStock: jest.Mock };
  let paymentSaleService: { createInTransaction: jest.Mock };
  let aggregator: { generatePaymentLink: jest.Mock; verifyWebhookSignature: jest.Mock };
  let cashSessionService: { findOpenSessionInTransaction: jest.Mock };
  let config: { get: jest.Mock };
  let queue: { add: jest.Mock };
  const toEmit = jest.fn();

  beforeEach(() => {
    const prismaMock = {
      client: { findUnique: jest.fn() },
      warehouse: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      productVariant: { findMany: jest.fn() },
      unit: { findMany: jest.fn() },
      productWarehouse: { findFirst: jest.fn() },
      sale: { create: jest.fn(), findUniqueOrThrow: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };

    prismaMock.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)(prismaMock);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });

    const dcMock = { nextReference: jest.fn().mockResolvedValue(REF) };
    const rtMock = { server: { to: jest.fn().mockReturnValue({ emit: toEmit }) } };
    const pwMock = { adjustStock: jest.fn() };
    const notifMock = { createForOrg: jest.fn().mockResolvedValue(undefined) };
    const paymentMock = { createInTransaction: jest.fn().mockResolvedValue({}) };
    const aggregatorMock = {
      generatePaymentLink: jest.fn().mockResolvedValue('https://pay.test/mock-123'),
      verifyWebhookSignature: jest.fn().mockReturnValue(true),
    };
    const configMock = { get: jest.fn().mockReturnValue(undefined) };
    const queueMock = { add: jest.fn().mockResolvedValue(undefined) };
    // Session OPEN par défaut — les tests pré-existants (stock, paiement, mobile money) ne
    // portent pas sur le gate de session (S23b) et doivent continuer à passer sans y penser ;
    // les tests dédiés au gate ci-dessous surchargent cette valeur (mockResolvedValueOnce(null)).
    const cashSessionMock = {
      findOpenSessionInTransaction: jest
        .fn()
        .mockResolvedValue({ id: CASH_SESSION_ID, reference: CASH_SESSION_REF }),
    };

    service = new PosService(
      prismaMock as never,
      dcMock as never,
      rtMock as never,
      pwMock as never,
      notifMock as never,
      paymentMock as never,
      aggregatorMock as never,
      cashSessionMock as never,
      configMock as never,
      queueMock as never,
    );
    prisma = prismaMock;
    productWarehouseService = pwMock;
    paymentSaleService = paymentMock;
    aggregator = aggregatorMock;
    cashSessionService = cashSessionMock;
    config = configMock;
    queue = queueMock;
  });

  afterEach(() => jest.clearAllMocks());

  function mockOwnershipOk() {
    prisma.client.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, organizationId: ORG_A, deletedAt: null, unitId: null }]);
    prisma.productVariant.findMany.mockResolvedValue([]);
    prisma.unit.findMany.mockResolvedValue([]);
  }

  function mockStockOk(pwQuantity: string, newQuantity: string) {
    prisma.productWarehouse.findFirst.mockResolvedValue({
      id: PW_ID,
      version: 0,
      quantity: new Decimal(pwQuantity),
      product: { stockAlert: 0, name: 'Produit' },
    });
    productWarehouseService.adjustStock.mockResolvedValue({
      id: PW_ID,
      productId: PROD_ID,
      productVariantId: null,
      warehouseId: WH_ID,
      quantity: new Decimal(newQuantity),
      version: 1,
    });
  }

  // ─── calculateTotal — non-divergence avec createSale ────────────────────────

  describe('calculateTotal', () => {
    it('produit le même grandTotal que la création réelle sur les mêmes lignes', async () => {
      const dto = {
        taxRate: '10',
        discount: '100',
        shipping: '50',
        details: [{ productId: PROD_ID, price: '1000', quantity: '2' }],
      };

      const preview = service.calculateTotal(dto);

      mockOwnershipOk();
      mockStockOk('10', '8');
      prisma.sale.create.mockResolvedValue(makeCreatedSale({ grandTotal: preview.grandTotal }));
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeCreatedSale({ grandTotal: preview.grandTotal }));

      await service.createSale(
        ORG_A,
        USER_ID,
        {
          ...dto,
          clientId: CLIENT_ID,
          warehouseId: WH_ID,
          paymentMethod: 'CASH',
          amountReceived: preview.grandTotal.toString(),
        } as CreatePosSaleDto,
      );

      const createArgs = prisma.sale.create.mock.calls[0][0] as { data: { grandTotal: Decimal } };
      expect(createArgs.data.grandTotal.toString()).toBe(preview.grandTotal.toString());
      // sumLines = 2000, taxGlobal = 200, discount = 100, shipping = 50 → 2150
      expect(preview.grandTotal.toString()).toBe('2150');
    });
  });

  // ─── createSale — stock ──────────────────────────────────────────────────────

  describe('createSale — stock', () => {
    it('stock insuffisant → BadRequestException, adjustStock jamais appelé', async () => {
      mockOwnershipOk();
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('1'),
        product: { stockAlert: 0, name: 'Produit' },
      });

      await expect(service.createSale(ORG_A, USER_ID, baseDto())).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('décrémente le stock avec le delta cumulé correct', async () => {
      mockOwnershipOk();
      mockStockOk('10', '8');
      prisma.sale.create.mockResolvedValue(makeCreatedSale());
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeCreatedSale());

      await service.createSale(ORG_A, USER_ID, baseDto());

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      const [, , , delta] = productWarehouseService.adjustStock.mock.calls[0] as [unknown, unknown, unknown, Decimal];
      expect(delta.toString()).toBe('-2');
    });

    it("vente d'une autre organisation (warehouse hors org) → ForbiddenException", async () => {
      prisma.client.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

      await expect(service.createSale(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('lève ConflictException si adjustStock lève OptimisticLockException', async () => {
      mockOwnershipOk();
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('10'),
        product: { stockAlert: 0, name: 'Produit' },
      });
      productWarehouseService.adjustStock.mockRejectedValue(new OptimisticLockException(PW_ID, 0, 1));

      await expect(service.createSale(ORG_A, USER_ID, baseDto())).rejects.toThrow(ConflictException);
    });
  });

  // ─── createSale — session de caisse (S23b) ──────────────────────────────────

  describe('createSale — session de caisse', () => {
    it('aucune session OPEN pour cet entrepôt → BadRequestException, stock jamais décrémenté', async () => {
      mockOwnershipOk();
      mockStockOk('10', '8');
      cashSessionService.findOpenSessionInTransaction.mockResolvedValueOnce(null);

      await expect(service.createSale(ORG_A, USER_ID, baseDto())).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
      expect(prisma.sale.create).not.toHaveBeenCalled();
    });

    it('session OPEN trouvée → recherchée pour (organizationId, userId, warehouseId) et rattachée à la vente créée', async () => {
      mockOwnershipOk();
      mockStockOk('10', '8');
      prisma.sale.create.mockResolvedValue(makeCreatedSale());
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeCreatedSale());

      await service.createSale(ORG_A, USER_ID, baseDto());

      expect(cashSessionService.findOpenSessionInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        ORG_A,
        USER_ID,
        WH_ID,
      );
      const createArgs = prisma.sale.create.mock.calls[0][0] as { data: { cashSessionId: string } };
      expect(createArgs.data.cashSessionId).toBe(CASH_SESSION_ID);
    });
  });

  // ─── createSale — paiement CASH/CARD ────────────────────────────────────────

  describe('createSale — paiement immédiat', () => {
    it('CASH : crée un PaymentSale via createInTransaction avec la monnaie rendue correcte', async () => {
      mockOwnershipOk();
      mockStockOk('10', '8');
      prisma.sale.create.mockResolvedValue(makeCreatedSale({ grandTotal: new Decimal('2000') }));
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeCreatedSale({ grandTotal: new Decimal('2000') }));

      await service.createSale(ORG_A, USER_ID, baseDto({ amountReceived: '2500' }));

      expect(paymentSaleService.createInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        ORG_A,
        USER_ID,
        SALE_ID,
        expect.objectContaining({ amount: '2000', method: 'CASH', change: '500' }),
      );
    });

    it('CASH : amountReceived < grandTotal → BadRequestException', async () => {
      mockOwnershipOk();
      mockStockOk('10', '8');
      prisma.sale.create.mockResolvedValue(makeCreatedSale({ grandTotal: new Decimal('2000') }));

      await expect(
        service.createSale(ORG_A, USER_ID, baseDto({ amountReceived: '1000' })),
      ).rejects.toThrow(BadRequestException);
      expect(paymentSaleService.createInTransaction).not.toHaveBeenCalled();
    });

    it('CARD : change toujours à 0, amount = grandTotal exact', async () => {
      mockOwnershipOk();
      mockStockOk('10', '8');
      prisma.sale.create.mockResolvedValue(makeCreatedSale({ grandTotal: new Decimal('2000') }));
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeCreatedSale({ grandTotal: new Decimal('2000') }));

      await service.createSale(ORG_A, USER_ID, baseDto({ paymentMethod: 'CARD', amountReceived: undefined }));

      expect(paymentSaleService.createInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        ORG_A,
        USER_ID,
        SALE_ID,
        expect.objectContaining({ amount: '2000', method: 'CARD', change: '0' }),
      );
    });
  });

  // ─── createSale — MOBILE_MONEY ───────────────────────────────────────────────

  describe('createSale — MOBILE_MONEY', () => {
    it('status AWAITING_PAYMENT, aucun PaymentSale créé, lien généré, job enfilé', async () => {
      mockOwnershipOk();
      mockStockOk('10', '8');
      prisma.sale.create.mockResolvedValue(makeCreatedSale({ status: 'AWAITING_PAYMENT', grandTotal: new Decimal('2000') }));
      prisma.sale.findUniqueOrThrow.mockResolvedValue(
        makeCreatedSale({ status: 'AWAITING_PAYMENT', grandTotal: new Decimal('2000') }),
      );

      const result = await service.createSale(
        ORG_A,
        USER_ID,
        baseDto({ paymentMethod: 'MOBILE_MONEY', amountReceived: undefined }),
      );

      expect(paymentSaleService.createInTransaction).not.toHaveBeenCalled();
      const createArgs = prisma.sale.create.mock.calls[0][0] as { data: { status: string } };
      expect(createArgs.data.status).toBe('AWAITING_PAYMENT');

      expect(aggregator.generatePaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({ reference: SALE_ID }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'pos.expirePayment',
        { saleId: SALE_ID, organizationId: ORG_A },
        expect.objectContaining({ delay: 180_000 }),
      );
      expect(result.paymentLink).toBe('https://pay.test/mock-123');
    });

    it('utilise POS_PAYMENT_TIMEOUT_MS depuis la config si défini', async () => {
      config.get.mockImplementation((key: string) => (key === 'POS_PAYMENT_TIMEOUT_MS' ? '60000' : undefined));
      mockOwnershipOk();
      mockStockOk('10', '8');
      prisma.sale.create.mockResolvedValue(makeCreatedSale({ status: 'AWAITING_PAYMENT' }));
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeCreatedSale({ status: 'AWAITING_PAYMENT' }));

      await service.createSale(ORG_A, USER_ID, baseDto({ paymentMethod: 'MOBILE_MONEY', amountReceived: undefined }));

      expect(queue.add).toHaveBeenCalledWith(
        'pos.expirePayment',
        expect.anything(),
        expect.objectContaining({ delay: 60_000 }),
      );
    });
  });

  // ─── confirmMobileMoneyPayment ───────────────────────────────────────────────

  describe('confirmMobileMoneyPayment', () => {
    it('AWAITING_PAYMENT → COMPLETED + PaymentSale créé', async () => {
      const saleFindUnique = jest.fn().mockResolvedValue({
        organizationId: ORG_A,
        status: 'AWAITING_PAYMENT',
        grandTotal: new Decimal('2000'),
        date: new Date('2026-07-27'),
        userId: USER_ID,
      });
      const saleUpdate = jest.fn().mockResolvedValue({});
      (prisma as unknown as { sale: { findUnique: jest.Mock; update: jest.Mock } }).sale.findUnique = saleFindUnique;
      (prisma as unknown as { sale: { findUnique: jest.Mock; update: jest.Mock } }).sale.update = saleUpdate;

      await service.confirmMobileMoneyPayment(ORG_A, SALE_ID);

      expect(saleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SALE_ID }, data: { status: 'COMPLETED' } }),
      );
      expect(paymentSaleService.createInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        ORG_A,
        USER_ID,
        SALE_ID,
        expect.objectContaining({ method: 'MOBILE_MONEY', amount: '2000' }),
      );
    });

    it('vente déjà COMPLETED → no-op idempotent (pas de double PaymentSale)', async () => {
      const saleFindUnique = jest.fn().mockResolvedValue({
        organizationId: ORG_A,
        status: 'COMPLETED',
        grandTotal: new Decimal('2000'),
        date: new Date('2026-07-27'),
        userId: USER_ID,
      });
      const saleUpdate = jest.fn();
      (prisma as unknown as { sale: { findUnique: jest.Mock; update: jest.Mock } }).sale.findUnique = saleFindUnique;
      (prisma as unknown as { sale: { findUnique: jest.Mock; update: jest.Mock } }).sale.update = saleUpdate;

      await service.confirmMobileMoneyPayment(ORG_A, SALE_ID);

      expect(saleUpdate).not.toHaveBeenCalled();
      expect(paymentSaleService.createInTransaction).not.toHaveBeenCalled();
    });

    it("vente d'une autre organisation → no-op (jamais d'exception, jamais de fuite cross-tenant)", async () => {
      const saleFindUnique = jest.fn().mockResolvedValue({
        organizationId: ORG_B,
        status: 'AWAITING_PAYMENT',
        grandTotal: new Decimal('2000'),
        date: new Date('2026-07-27'),
        userId: USER_ID,
      });
      const saleUpdate = jest.fn();
      (prisma as unknown as { sale: { findUnique: jest.Mock; update: jest.Mock } }).sale.findUnique = saleFindUnique;
      (prisma as unknown as { sale: { findUnique: jest.Mock; update: jest.Mock } }).sale.update = saleUpdate;

      await expect(service.confirmMobileMoneyPayment(ORG_A, SALE_ID)).resolves.toBeUndefined();
      expect(saleUpdate).not.toHaveBeenCalled();
    });
  });

  // ─── searchProducts ───────────────────────────────────────────────────────────

  describe('searchProducts', () => {
    it('retourne la quantité live du ProductWarehouse pour l\'entrepôt demandé', async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      (prisma.product.findMany as jest.Mock).mockResolvedValue([
        {
          id: PROD_ID,
          code: 'PROD-001',
          name: 'Produit Test',
          price: new Decimal('1000'),
          taxRate: new Decimal('0'),
          taxMethod: 'percentage',
          unitId: null,
          unitSaleId: null,
          stocks: [{ quantity: new Decimal('42') }],
        },
      ]);

      const results = await service.searchProducts(ORG_A, WH_ID, 'prod');

      expect(results[0]!.quantity.toString()).toBe('42');
    });

    it("retourne 0 si aucun ProductWarehouse n'existe pour cet entrepôt", async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
      (prisma.product.findMany as jest.Mock).mockResolvedValue([
        {
          id: PROD_ID,
          code: 'PROD-001',
          name: 'Produit Test',
          price: new Decimal('1000'),
          taxRate: new Decimal('0'),
          taxMethod: 'percentage',
          unitId: null,
          unitSaleId: null,
          stocks: [],
        },
      ]);

      const results = await service.searchProducts(ORG_A, WH_ID);

      expect(results[0]!.quantity.toString()).toBe('0');
    });

    it("entrepôt d'une autre organisation → ForbiddenException", async () => {
      prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

      await expect(service.searchProducts(ORG_A, WH_ID)).rejects.toThrow(ForbiddenException);
    });

    it('entrepôt introuvable → NotFoundException', async () => {
      prisma.warehouse.findUnique.mockResolvedValue(null);

      await expect(service.searchProducts(ORG_A, WH_ID)).rejects.toThrow(NotFoundException);
    });
  });
});
