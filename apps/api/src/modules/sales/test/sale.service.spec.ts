import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { SaleService } from '../sale.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A     = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B     = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID   = 'user0000-0000-0000-0000-000000000001';
const OTHER_USER = 'user0000-0000-0000-0000-000000000002';
const CLIENT_ID = 'client01-0000-0000-0000-000000000001';
const WH_ID     = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID   = 'prod0000-0000-0000-0000-000000000001';
const SALE_ID   = 'sale0001-0000-0000-0000-000000000001';
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
    sale: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    saleDetail: { deleteMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };
  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      client: { findUnique: jest.fn() },
      warehouse: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      productVariant: { findMany: jest.fn() },
      unit: { findMany: jest.fn() },
      sale: {
        create: jest.fn(),
        findUnique: jest.fn(),
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

    const dcMock = { nextReference: jest.fn().mockResolvedValue(REF) };
    const rtMock = { server: { to: jest.fn().mockReturnValue({ emit: toEmit }) } };

    const module = await Test.createTestingModule({
      providers: [
        SaleService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
        { provide: RealtimeGateway, useValue: rtMock },
      ],
    }).compile();

    service = module.get(SaleService);
    prisma = prismaMock;
    documentCounter = dcMock;
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
});
