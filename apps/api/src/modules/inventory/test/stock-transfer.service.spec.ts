import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { StockTransferService } from '../stock-transfer.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NotificationService } from '../../notifications/notification.service';
import { ProductWarehouseService, OptimisticLockException } from '../product-warehouse.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A    = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B    = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID  = 'user0000-0000-0000-0000-000000000001';
const WH_FROM  = 'whfrom01-0000-0000-0000-000000000001';
const WH_TO    = 'whto0001-0000-0000-0000-000000000002';
const PROD_ID  = 'prod0000-0000-0000-0000-000000000001';
const TRF_ID   = 'trf00001-0000-0000-0000-000000000001';
const DETAIL_ID = 'det00001-0000-0000-0000-000000000001';
const PW_FROM_ID = 'pwfrom01-0000-0000-0000-000000000001';
const PW_TO_ID   = 'pwto0001-0000-0000-0000-000000000002';
const REF      = 'TRF-2026-000001';

function makeTransfer(overrides: Partial<{
  id: string;
  status: 'DRAFT' | 'VALIDATED';
  organizationId: string;
  deletedAt: Date | null;
  details: unknown[];
}> = {}) {
  return {
    id: TRF_ID,
    organizationId: ORG_A,
    reference: REF,
    date: new Date('2026-07-21'),
    fromWarehouseId: WH_FROM,
    toWarehouseId: WH_TO,
    userId: USER_ID,
    note: null,
    status: 'DRAFT',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    details: [
      {
        id: DETAIL_ID,
        productId: PROD_ID,
        productVariantId: null,
        quantity: new Decimal('5'),
      },
    ],
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('StockTransferService', () => {
  let service: StockTransferService;

  let prisma: {
    warehouse: { findUnique: jest.Mock };
    product: { findMany: jest.Mock; findUnique?: jest.Mock };
    productVariant: { findMany: jest.Mock };
    productWarehouse: { findFirst: jest.Mock };
    stockTransfer: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };
  let pwService: { adjustStock: jest.Mock };
  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      warehouse: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      productVariant: { findMany: jest.fn() },
      productWarehouse: { findFirst: jest.fn() },
      stockTransfer: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    prismaMock.$transaction.mockImplementation(
      (arg: unknown, _opts?: unknown) => {
        if (typeof arg === 'function') {
          return (arg as (tx: unknown) => unknown)(prismaMock);
        }
        return Promise.all(arg as Promise<unknown>[]);
      },
    );

    const dcMock    = { nextReference: jest.fn().mockResolvedValue(REF) };
    const rtMock    = { server: { to: jest.fn().mockReturnValue({ emit: toEmit }) } };
    const pwMock    = { adjustStock: jest.fn() };
    const notifMock = { createForOrg: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        StockTransferService,
        { provide: PrismaService,           useValue: prismaMock },
        { provide: DocumentCounterService,  useValue: dcMock },
        { provide: RealtimeGateway,         useValue: rtMock },
        { provide: ProductWarehouseService, useValue: pwMock },
        { provide: NotificationService,     useValue: notifMock },
      ],
    }).compile();

    service         = module.get(StockTransferService);
    prisma          = prismaMock;
    documentCounter = dcMock;
    pwService       = pwMock;
  });

  afterEach(() => jest.clearAllMocks());

  // ─── create ──────────────────────────────────────────────────────────────

  it('create : crée un transfert DRAFT avec référence et détails', async () => {
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, organizationId: ORG_A, deletedAt: null }]);
    prisma.productVariant.findMany.mockResolvedValue([]);
    prisma.stockTransfer.create.mockResolvedValue(makeTransfer());

    const result = await service.create(ORG_A, USER_ID, {
      fromWarehouseId: WH_FROM,
      toWarehouseId: WH_TO,
      date: '2026-07-21T00:00:00.000Z',
      details: [{ productId: PROD_ID, quantity: '5' }],
    });

    expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
    expect(prisma.stockTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DRAFT', reference: REF }),
      }),
    );
    expect(result.status).toBe('DRAFT');
    expect(result.reference).toBe(REF);
  });

  it('create : lève BadRequestException si fromWarehouseId === toWarehouseId', async () => {
    await expect(
      service.create(ORG_A, USER_ID, {
        fromWarehouseId: WH_FROM,
        toWarehouseId: WH_FROM, // même entrepôt
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: PROD_ID, quantity: '5' }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("create : lève ForbiddenException si l'entrepôt source appartient à une autre org", async () => {
    prisma.warehouse.findUnique.mockResolvedValueOnce({ organizationId: ORG_B, deletedAt: null });

    await expect(
      service.create(ORG_A, USER_ID, {
        fromWarehouseId: WH_FROM,
        toWarehouseId: WH_TO,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: PROD_ID, quantity: '5' }],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('create : lève ForbiddenException si un productId appartient à une autre org', async () => {
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, organizationId: ORG_B, deletedAt: null }]);

    await expect(
      service.create(ORG_A, USER_ID, {
        fromWarehouseId: WH_FROM,
        toWarehouseId: WH_TO,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: PROD_ID, quantity: '5' }],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  // ─── validate ────────────────────────────────────────────────────────────

  it('validate : appelle adjustStock ×2 par ligne (source − destination +), passe status à VALIDATED', async () => {
    const trf = makeTransfer();
    prisma.stockTransfer.findUnique.mockResolvedValue(trf);

    const pwFrom = { id: PW_FROM_ID, version: 0, quantity: new Decimal('10'), product: { name: 'Prod', stockAlert: 0 } };
    const pwTo   = { id: PW_TO_ID,   version: 0 };

    prisma.productWarehouse.findFirst
      .mockResolvedValueOnce(pwFrom)
      .mockResolvedValueOnce(pwTo);

    const updatedFrom = { id: PW_FROM_ID, productId: PROD_ID, productVariantId: null, warehouseId: WH_FROM, quantity: new Decimal('5'), version: 1 };
    pwService.adjustStock
      .mockResolvedValueOnce(updatedFrom)
      .mockResolvedValueOnce({ id: PW_TO_ID, productId: PROD_ID, productVariantId: null, warehouseId: WH_TO, quantity: new Decimal('5'), version: 1 });

    prisma.stockTransfer.update.mockResolvedValue({});
    prisma.stockTransfer.findUniqueOrThrow.mockResolvedValue(makeTransfer({ status: 'VALIDATED' }));

    const result = await service.validate(TRF_ID, ORG_A);

    // adjustStock appelé exactement 2 fois (source puis destination)
    expect(pwService.adjustStock).toHaveBeenCalledTimes(2);

    // Premier appel : delta négatif (décrémentation source)
    const [, , , deltaFrom] = (pwService.adjustStock as jest.Mock).mock.calls[0] as [unknown, unknown, unknown, Decimal];
    expect(deltaFrom.isNegative()).toBe(true);

    // Second appel : delta positif (incrémentation destination)
    const [, , , deltaTo] = (pwService.adjustStock as jest.Mock).mock.calls[1] as [unknown, unknown, unknown, Decimal];
    expect(deltaTo.isPositive()).toBe(true);

    expect(result.status).toBe('VALIDATED');
  });

  it('validate : émet stock:updated ×2 (source et destination) après la transaction', async () => {
    const trf = makeTransfer();
    prisma.stockTransfer.findUnique.mockResolvedValue(trf);

    prisma.productWarehouse.findFirst
      .mockResolvedValueOnce({ id: PW_FROM_ID, version: 0, quantity: new Decimal('10'), product: { name: 'P', stockAlert: 0 } })
      .mockResolvedValueOnce({ id: PW_TO_ID, version: 0 });

    pwService.adjustStock
      .mockResolvedValueOnce({ id: PW_FROM_ID, productId: PROD_ID, productVariantId: null, warehouseId: WH_FROM, quantity: new Decimal('5'), version: 1 })
      .mockResolvedValueOnce({ id: PW_TO_ID,   productId: PROD_ID, productVariantId: null, warehouseId: WH_TO,   quantity: new Decimal('5'), version: 1 });

    prisma.stockTransfer.update.mockResolvedValue({});
    prisma.stockTransfer.findUniqueOrThrow.mockResolvedValue(makeTransfer({ status: 'VALIDATED' }));

    await service.validate(TRF_ID, ORG_A);

    // stock:updated émis 2 fois (source + destination)
    expect(toEmit).toHaveBeenCalledTimes(2);
    expect(toEmit).toHaveBeenCalledWith('stock:updated', expect.objectContaining({ warehouseId: WH_FROM }));
    expect(toEmit).toHaveBeenCalledWith('stock:updated', expect.objectContaining({ warehouseId: WH_TO }));
  });

  it('validate : émet stock:lowAlert si newQuantity source ≤ stockAlert', async () => {
    const trf = makeTransfer();
    prisma.stockTransfer.findUnique.mockResolvedValue(trf);

    prisma.productWarehouse.findFirst
      .mockResolvedValueOnce({ id: PW_FROM_ID, version: 0, quantity: new Decimal('10'), product: { name: 'Prod X', stockAlert: 10 } })
      .mockResolvedValueOnce({ id: PW_TO_ID, version: 0 });

    // Après décrémentation, il reste 3 (< seuil 10) → lowAlert
    pwService.adjustStock
      .mockResolvedValueOnce({ id: PW_FROM_ID, productId: PROD_ID, productVariantId: null, warehouseId: WH_FROM, quantity: new Decimal('3'), version: 1 })
      .mockResolvedValueOnce({ id: PW_TO_ID,   productId: PROD_ID, productVariantId: null, warehouseId: WH_TO,   quantity: new Decimal('5'), version: 1 });

    prisma.stockTransfer.update.mockResolvedValue({});
    prisma.stockTransfer.findUniqueOrThrow.mockResolvedValue(makeTransfer({ status: 'VALIDATED' }));

    await service.validate(TRF_ID, ORG_A);

    expect(toEmit).toHaveBeenCalledWith('stock:lowAlert', expect.objectContaining({ productId: PROD_ID, threshold: 10 }));
  });

  it('validate : lève ConflictException si OptimisticLockException sur la source', async () => {
    const trf = makeTransfer();
    prisma.stockTransfer.findUnique.mockResolvedValue(trf);

    prisma.productWarehouse.findFirst
      .mockResolvedValueOnce({ id: PW_FROM_ID, version: 0, quantity: new Decimal('10'), product: { name: 'P', stockAlert: 0 } })
      .mockResolvedValueOnce({ id: PW_TO_ID, version: 0 });

    pwService.adjustStock.mockRejectedValueOnce(new OptimisticLockException(PW_FROM_ID, 0, 1));

    await expect(service.validate(TRF_ID, ORG_A)).rejects.toThrow(ConflictException);
  });

  it('validate : lève ConflictException si OptimisticLockException sur la destination', async () => {
    const trf = makeTransfer();
    prisma.stockTransfer.findUnique.mockResolvedValue(trf);

    prisma.productWarehouse.findFirst
      .mockResolvedValueOnce({ id: PW_FROM_ID, version: 0, quantity: new Decimal('10'), product: { name: 'P', stockAlert: 0 } })
      .mockResolvedValueOnce({ id: PW_TO_ID, version: 0 });

    pwService.adjustStock
      .mockResolvedValueOnce({ id: PW_FROM_ID, productId: PROD_ID, productVariantId: null, warehouseId: WH_FROM, quantity: new Decimal('5'), version: 1 })
      .mockRejectedValueOnce(new OptimisticLockException(PW_TO_ID, 0, 1));

    await expect(service.validate(TRF_ID, ORG_A)).rejects.toThrow(ConflictException);
  });

  it('validate : lève BadRequestException si transfert déjà VALIDATED', async () => {
    prisma.stockTransfer.findUnique.mockResolvedValue(makeTransfer({ status: 'VALIDATED' }));

    await expect(service.validate(TRF_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('validate : lève NotFoundException si le transfert est introuvable', async () => {
    prisma.stockTransfer.findUnique.mockResolvedValue(null);

    await expect(service.validate(TRF_ID, ORG_A)).rejects.toThrow(NotFoundException);
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it('remove : lève BadRequestException si transfert VALIDATED', async () => {
    prisma.stockTransfer.findUnique.mockResolvedValue(
      makeTransfer({ status: 'VALIDATED', deletedAt: null }),
    );

    await expect(service.remove(TRF_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('remove : soft-delete un transfert DRAFT', async () => {
    prisma.stockTransfer.findUnique.mockResolvedValue(makeTransfer({ status: 'DRAFT' }));
    prisma.stockTransfer.update.mockResolvedValue({});

    await service.remove(TRF_ID, ORG_A);

    expect(prisma.stockTransfer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TRF_ID },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});
