import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { SaleService } from '../sale.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ProductWarehouseService, OptimisticLockException } from '../../inventory/product-warehouse.service';
import { NotificationService } from '../../notifications/notification.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A     = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B     = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID   = 'user0000-0000-0000-0000-000000000001';
const OTHER_USER = 'user0000-0000-0000-0000-000000000002';
const CLIENT_ID = 'client01-0000-0000-0000-000000000001';
const WH_ID     = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID   = 'prod0000-0000-0000-0000-000000000001';
const SALE_ID   = 'sale0001-0000-0000-0000-000000000001';
const PW_ID     = 'pw000001-0000-0000-0000-000000000001';
const UNIT_PIECE  = 'unit0001-0000-0000-0000-000000000001';
const UNIT_CARTON = 'unit0002-0000-0000-0000-000000000002';
const REF       = 'VTE-2026-000001';

function makeSale(overrides: Partial<{
  id: string;
  organizationId: string;
  userId: string;
  status: 'PENDING' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'CANCELLED';
  deletedAt: Date | null;
  taxRate: Decimal;
  discount: Decimal;
  shipping: Decimal;
  details: unknown[];
}> = {}) {
  return {
    id: SALE_ID,
    organizationId: ORG_A,
    reference: REF,
    date: new Date('2026-07-26'),
    isPos: false,
    userId: USER_ID,
    clientId: CLIENT_ID,
    warehouseId: WH_ID,
    taxRate: new Decimal('0'),
    taxAmount: new Decimal('0'),
    discount: new Decimal('0'),
    shipping: new Decimal('0'),
    grandTotal: new Decimal('15000'),
    paidAmount: new Decimal('0'),
    paymentStatus: 'UNPAID',
    status: 'PENDING',
    notes: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    details: [
      {
        id: 'det00001',
        productId: PROD_ID,
        productVariantId: null,
        saleUnitId: null,
        price: new Decimal('15000'),
        taxAmount: new Decimal('0'),
        taxMethod: 'percentage',
        discount: new Decimal('0'),
        discountMethod: 'percentage',
        quantity: new Decimal('1'),
        total: new Decimal('15000'),
      },
    ],
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('SaleService', () => {
  let service: SaleService;

  let prisma: {
    client: { findUnique: jest.Mock };
    warehouse: { findUnique: jest.Mock };
    product: { findMany: jest.Mock };
    productVariant: { findMany: jest.Mock };
    unit: { findMany: jest.Mock };
    productWarehouse: { findFirst: jest.Mock };
    sale: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    saleDetail: { deleteMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };
  let productWarehouseService: { adjustStock: jest.Mock };
  let notificationService: { createForOrg: jest.Mock };
  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      client: { findUnique: jest.fn() },
      warehouse: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      productVariant: { findMany: jest.fn() },
      unit: { findMany: jest.fn() },
      productWarehouse: { findFirst: jest.fn() },
      sale: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      saleDetail: { deleteMany: jest.fn(), createMany: jest.fn() },
      $transaction: jest.fn(),
    };

    prismaMock.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)(prismaMock);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });

    const dcMock    = { nextReference: jest.fn().mockResolvedValue(REF) };
    const rtMock    = { server: { to: jest.fn().mockReturnValue({ emit: toEmit }) } };
    const pwMock    = { adjustStock: jest.fn() };
    const notifMock = { createForOrg: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        SaleService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
        { provide: RealtimeGateway, useValue: rtMock },
        { provide: ProductWarehouseService, useValue: pwMock },
        { provide: NotificationService, useValue: notifMock },
      ],
    }).compile();

    service = module.get(SaleService);
    prisma = prismaMock;
    documentCounter = dcMock;
    productWarehouseService = pwMock;
    notificationService = notifMock;
  });

  afterEach(() => jest.clearAllMocks());

  function baseDto(overrides: Record<string, unknown> = {}) {
    return {
      clientId: CLIENT_ID,
      warehouseId: WH_ID,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: PROD_ID, price: '15000', quantity: '1' }],
      ...overrides,
    };
  }

  function mockOwnershipOk() {
    prisma.client.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, organizationId: ORG_A, deletedAt: null }]);
    prisma.productVariant.findMany.mockResolvedValue([]);
    prisma.unit.findMany.mockResolvedValue([]);
  }

  // ─── create ──────────────────────────────────────────────────────────────

  it('create : crée une vente PENDING avec référence VTE-… et grandTotal calculé (Decimal)', async () => {
    mockOwnershipOk();
    prisma.sale.create.mockResolvedValue(makeSale());

    const result = await service.create(ORG_A, USER_ID, baseDto());

    expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
    expect(prisma.sale.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          reference: REF,
          paymentStatus: 'UNPAID',
        }),
      }),
    );
    // subTotal = 15000 × 1 = 15000, pas de taxe/remise → grandTotal = 15000
    const createArgs = prisma.sale.create.mock.calls[0][0] as {
      data: { grandTotal: Decimal };
    };
    expect(createArgs.data.grandTotal.toString()).toBe('15000');
    expect(result.reference).toBe(REF);
  });

  it('create : taxe en percentage vs fixed → totaux de ligne distincts', async () => {
    mockOwnershipOk();
    prisma.sale.create.mockResolvedValue(makeSale());

    await service.create(
      ORG_A,
      USER_ID,
      baseDto({
        details: [{ productId: PROD_ID, price: '1000', quantity: '2', taxAmount: '10', taxMethod: 'percentage' }],
      }),
    );
    const percentArgs = prisma.sale.create.mock.calls[0][0] as {
      data: { details: { create: { total: Decimal }[] } };
    };
    // subTotal = 2000, taxe 10% = 200 → total ligne = 2200
    expect(percentArgs.data.details.create[0]!.total.toString()).toBe('2200');

    jest.clearAllMocks();
    mockOwnershipOk();
    prisma.sale.create.mockResolvedValue(makeSale());

    await service.create(
      ORG_A,
      USER_ID,
      baseDto({
        details: [{ productId: PROD_ID, price: '1000', quantity: '2', taxAmount: '10', taxMethod: 'fixed' }],
      }),
    );
    const fixedArgs = prisma.sale.create.mock.calls[0][0] as {
      data: { details: { create: { total: Decimal }[] } };
    };
    // subTotal = 2000, taxe fixe = 10 → total ligne = 2010
    expect(fixedArgs.data.details.create[0]!.total.toString()).toBe('2010');
  });

  it('create : discount global déduit du grandTotal', async () => {
    mockOwnershipOk();
    prisma.sale.create.mockResolvedValue(makeSale());

    await service.create(
      ORG_A,
      USER_ID,
      baseDto({
        details: [{ productId: PROD_ID, price: '10000', quantity: '1' }],
        discount: '1500',
        shipping: '500',
      }),
    );

    const createArgs = prisma.sale.create.mock.calls[0][0] as {
      data: { grandTotal: Decimal };
    };
    // sumLines = 10000, taxGlobal = 0, discount = 1500, shipping = 500 → 10000 - 1500 + 500 = 9000
    expect(createArgs.data.grandTotal.toString()).toBe('9000');
  });

  it("create : lève ForbiddenException si le clientId appartient à une autre org", async () => {
    prisma.client.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

    await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
  });

  it("create : lève ForbiddenException si le warehouseId appartient à une autre org", async () => {
    prisma.client.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

    await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
  });

  // ─── findAll ─────────────────────────────────────────────────────────────

  it('findAll : viewAll=false injecte un filtre userId', async () => {
    prisma.sale.findMany.mockResolvedValue([]);
    prisma.sale.count.mockResolvedValue(0);

    await service.findAll(ORG_A, OTHER_USER, false, 1, 20);

    expect(prisma.sale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_A, userId: OTHER_USER }),
      }),
    );
  });

  it('findAll : viewAll=true ne filtre pas par userId', async () => {
    prisma.sale.findMany.mockResolvedValue([]);
    prisma.sale.count.mockResolvedValue(0);

    await service.findAll(ORG_A, OTHER_USER, true, 1, 20);

    const call = prisma.sale.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty('userId');
  });

  // ─── update ──────────────────────────────────────────────────────────────

  it('update : lève BadRequestException si la vente est COMPLETED', async () => {
    prisma.sale.findUnique.mockResolvedValue(makeSale({ status: 'COMPLETED' }));

    await expect(
      service.update(SALE_ID, ORG_A, { notes: 'x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('update : lève NotFoundException si la vente est introuvable', async () => {
    prisma.sale.findUnique.mockResolvedValue(null);

    await expect(service.update(SALE_ID, ORG_A, { notes: 'x' })).rejects.toThrow(NotFoundException);
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it('remove : lève BadRequestException si la vente est COMPLETED', async () => {
    prisma.sale.findUnique.mockResolvedValue(makeSale({ status: 'COMPLETED' }));

    await expect(service.remove(SALE_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('remove : soft-delete une vente PENDING', async () => {
    prisma.sale.findUnique.mockResolvedValue(makeSale({ status: 'PENDING' }));
    prisma.sale.update.mockResolvedValue({});

    await service.remove(SALE_ID, ORG_A);

    expect(prisma.sale.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SALE_ID },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  // ─── validate (S21) ──────────────────────────────────────────────────────

  describe('validate', () => {
    /** Construit une vente PENDING avec des lignes personnalisées pour les tests de validate(). */
    function makeValidateSale(details: Record<string, unknown>[]) {
      return makeSale({ status: 'PENDING', details });
    }

    function mockValidateHappyPath(opts: {
      pwQuantity: string;
      newQuantity: string;
      stockAlert?: number;
      productName?: string;
    }) {
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal(opts.pwQuantity),
        product: { stockAlert: opts.stockAlert ?? 0, name: opts.productName ?? 'Produit' },
      });
      productWarehouseService.adjustStock.mockResolvedValue({
        id: PW_ID,
        productId: PROD_ID,
        productVariantId: null,
        warehouseId: WH_ID,
        quantity: new Decimal(opts.newQuantity),
        version: 1,
      });
      prisma.sale.update.mockResolvedValue({});
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeSale({ status: 'COMPLETED' }));
    }

    it('décrémente correctement le stock d\'une ligne simple', async () => {
      prisma.sale.findUnique.mockResolvedValue(
        makeValidateSale([
          { id: 'det1', productId: PROD_ID, productVariantId: null, saleUnitId: null, quantity: new Decimal('3') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      mockValidateHappyPath({ pwQuantity: '10', newQuantity: '7' });

      const result = await service.validate(SALE_ID, ORG_A);

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      const [, pwId, org, delta, version] = productWarehouseService.adjustStock.mock.calls[0] as [
        unknown, string, string, Decimal, number,
      ];
      expect(pwId).toBe(PW_ID);
      expect(org).toBe(ORG_A);
      expect(delta.toString()).toBe('-3');
      expect(version).toBe(0);
      expect(prisma.sale.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SALE_ID }, data: { status: 'COMPLETED' } }),
      );
      expect(result.status).toBe('COMPLETED');
    });

    it('convertit la quantité via saleUnitId (2 cartons × 12 = 24 pièces décrémentées)', async () => {
      prisma.sale.findUnique.mockResolvedValue(
        makeValidateSale([
          { id: 'det1', productId: PROD_ID, productVariantId: null, saleUnitId: UNIT_CARTON, quantity: new Decimal('2') },
        ]),
      );
      // Le produit est stocké en pièces — l'unité de vente (carton) diffère → conversion.
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([
        { id: UNIT_CARTON, operator: '*', operatorValue: new Decimal('12') },
      ]);
      mockValidateHappyPath({ pwQuantity: '100', newQuantity: '76' });

      await service.validate(SALE_ID, ORG_A);

      const [, , , delta] = productWarehouseService.adjustStock.mock.calls[0] as [unknown, unknown, unknown, Decimal];
      // 2 cartons × 12 = 24 pièces → décrément de 24
      expect(delta.toString()).toBe('-24');
    });

    it('deux lignes du même produit → un seul appel à adjustStock avec la quantité cumulée', async () => {
      prisma.sale.findUnique.mockResolvedValue(
        makeValidateSale([
          { id: 'det1', productId: PROD_ID, productVariantId: null, saleUnitId: null, quantity: new Decimal('2') },
          { id: 'det2', productId: PROD_ID, productVariantId: null, saleUnitId: null, quantity: new Decimal('3') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      mockValidateHappyPath({ pwQuantity: '20', newQuantity: '15' });

      await service.validate(SALE_ID, ORG_A);

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      const [, , , delta] = productWarehouseService.adjustStock.mock.calls[0] as [unknown, unknown, unknown, Decimal];
      // 2 + 3 = 5 cumulé, un seul mouvement de -5 — jamais deux appels de -2 puis -3.
      expect(delta.toString()).toBe('-5');
    });

    it('quantité demandée > stock disponible → BadRequestException, adjustStock jamais appelé', async () => {
      prisma.sale.findUnique.mockResolvedValue(
        makeValidateSale([
          { id: 'det1', productId: PROD_ID, productVariantId: null, saleUnitId: null, quantity: new Decimal('5') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('1'),
        product: { stockAlert: 0, name: 'Produit' },
      });

      await expect(service.validate(SALE_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('statut déjà COMPLETED → BadRequestException (pas de revalidation)', async () => {
      prisma.sale.findUnique.mockResolvedValue(makeValidateSale([]));
      prisma.sale.findUnique.mockResolvedValue(makeSale({ status: 'COMPLETED' }));

      await expect(service.validate(SALE_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it("vente d'une autre organisation → ForbiddenException", async () => {
      prisma.sale.findUnique.mockResolvedValue(makeSale({ organizationId: ORG_B, status: 'PENDING' }));

      await expect(service.validate(SALE_ID, ORG_A)).rejects.toThrow(ForbiddenException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('émet stock:lowAlert + NotificationService.createForOrg si le seuil est atteint après décrément', async () => {
      prisma.sale.findUnique.mockResolvedValue(
        makeValidateSale([
          { id: 'det1', productId: PROD_ID, productVariantId: null, saleUnitId: null, quantity: new Decimal('7') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      // Stock 10 − 7 = 3, seuil d'alerte 5 → 3 ≤ 5 → alerte
      mockValidateHappyPath({ pwQuantity: '10', newQuantity: '3', stockAlert: 5, productName: 'Produit X' });

      await service.validate(SALE_ID, ORG_A);

      expect(toEmit).toHaveBeenCalledWith(
        'stock:lowAlert',
        expect.objectContaining({ productId: PROD_ID, threshold: 5 }),
      );
      expect(notificationService.createForOrg).toHaveBeenCalledWith(
        ORG_A,
        'stock.lowAlert',
        expect.objectContaining({ productId: PROD_ID, productName: 'Produit X' }),
        'reports.quantityAlerts',
      );
    });

    it("n'émet pas stock:lowAlert si le stock restant est au-dessus du seuil", async () => {
      prisma.sale.findUnique.mockResolvedValue(
        makeValidateSale([
          { id: 'det1', productId: PROD_ID, productVariantId: null, saleUnitId: null, quantity: new Decimal('2') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      // Stock 10 − 2 = 8, seuil d'alerte 5 → 8 > 5 → pas d'alerte
      mockValidateHappyPath({ pwQuantity: '10', newQuantity: '8', stockAlert: 5 });

      await service.validate(SALE_ID, ORG_A);

      expect(toEmit).not.toHaveBeenCalledWith('stock:lowAlert', expect.anything());
      expect(notificationService.createForOrg).not.toHaveBeenCalled();
      // stock:updated reste émis dans tous les cas.
      expect(toEmit).toHaveBeenCalledWith('stock:updated', expect.anything());
    });

    it('lève ConflictException si adjustStock lève OptimisticLockException (conflit de version)', async () => {
      prisma.sale.findUnique.mockResolvedValue(
        makeValidateSale([
          { id: 'det1', productId: PROD_ID, productVariantId: null, saleUnitId: null, quantity: new Decimal('1') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('10'),
        product: { stockAlert: 0, name: 'Produit' },
      });
      productWarehouseService.adjustStock.mockRejectedValue(new OptimisticLockException(PW_ID, 0, 1));

      await expect(service.validate(SALE_ID, ORG_A)).rejects.toThrow(ConflictException);
    });
  });
});
