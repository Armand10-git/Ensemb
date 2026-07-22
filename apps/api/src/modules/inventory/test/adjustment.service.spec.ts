import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { AdjustmentService } from '../adjustment.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NotificationService } from '../../notifications/notification.service';
import { ProductWarehouseService, OptimisticLockException } from '../product-warehouse.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A   = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B   = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID = 'user0000-0000-0000-0000-000000000001';
const WH_ID   = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID = 'prod0000-0000-0000-0000-000000000001';
const ADJ_ID  = 'adj00001-0000-0000-0000-000000000001';
const DETAIL_ID = 'det00001-0000-0000-0000-000000000001';
const PW_ID   = 'pw000001-0000-0000-0000-000000000001';
const REF     = 'ADJ-2026-000001';

function makeAdjustment(overrides: Partial<{
  id: string;
  status: 'DRAFT' | 'VALIDATED';
  organizationId: string;
  deletedAt: Date | null;
  details: unknown[];
}> = {}) {
  return {
    id: ADJ_ID,
    organizationId: ORG_A,
    reference: REF,
    date: new Date('2026-07-21'),
    warehouseId: WH_ID,
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
        type: 'ADDITION',
        quantity: new Decimal('5'),
        unitCost: new Decimal('0'),
      },
    ],
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('AdjustmentService', () => {
  let service: AdjustmentService;

  let prisma: {
    warehouse: { findUnique: jest.Mock };
    product: { findMany: jest.Mock; findUnique: jest.Mock };
    adjustment: {
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
  let realtime: { server: { to: jest.Mock } };
  let pwService: { adjustStock: jest.Mock };

  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      warehouse: { findUnique: jest.fn() },
      product: { findMany: jest.fn(), findUnique: jest.fn() },
      adjustment: {
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

    const dcMock     = { nextReference: jest.fn().mockResolvedValue(REF) };
    const rtMock     = { server: { to: jest.fn().mockReturnValue({ emit: toEmit }) } };
    const pwMock     = { adjustStock: jest.fn() };
    const notifMock  = { createForOrg: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        AdjustmentService,
        { provide: PrismaService,           useValue: prismaMock },
        { provide: DocumentCounterService,  useValue: dcMock },
        { provide: RealtimeGateway,         useValue: rtMock },
        { provide: ProductWarehouseService, useValue: pwMock },
        { provide: NotificationService,     useValue: notifMock },
      ],
    }).compile();

    service         = module.get(AdjustmentService);
    prisma          = prismaMock;
    documentCounter = dcMock;
    realtime        = rtMock;
    pwService       = pwMock;
  });

  afterEach(() => jest.clearAllMocks());

  // ─── create ──────────────────────────────────────────────────────────────

  it('create : crée un ajustement DRAFT avec référence et détails', async () => {
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, organizationId: ORG_A, deletedAt: null }]);
    prisma.adjustment.create.mockResolvedValue(makeAdjustment());

    const result = await service.create(ORG_A, USER_ID, {
      warehouseId: WH_ID,
      date: '2026-07-21T00:00:00.000Z',
      details: [{ productId: PROD_ID, type: 'ADDITION', quantity: '5' }],
    });

    expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
    expect(prisma.adjustment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DRAFT', reference: REF }),
      }),
    );
    expect(result.status).toBe('DRAFT');
    expect(result.reference).toBe(REF);
  });

  it('create : lève ForbiddenException si warehouseId appartient à une autre org', async () => {
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

    await expect(
      service.create(ORG_A, USER_ID, {
        warehouseId: WH_ID,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: PROD_ID, type: 'ADDITION', quantity: '5' }],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('create : lève ForbiddenException si un productId appartient à une autre org', async () => {
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, organizationId: ORG_B, deletedAt: null }]);

    await expect(
      service.create(ORG_A, USER_ID, {
        warehouseId: WH_ID,
        date: '2026-07-21T00:00:00.000Z',
        details: [{ productId: PROD_ID, type: 'ADDITION', quantity: '5' }],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  // ─── validate ────────────────────────────────────────────────────────────

  it('validate : appelle adjustStock pour chaque ligne, passe status à VALIDATED', async () => {
    const adj = makeAdjustment();
    prisma.adjustment.findUnique.mockResolvedValue(adj);

    const pw = { id: PW_ID, version: 0, product: { name: 'Prod', stockAlert: 0 } };

    // findFirst retourné par tx (tx === prisma dans le mock)
    prisma.product.findMany.mockResolvedValue([]);

    // On ajoute productWarehouse.findFirst au mock (utilisé dans la transaction)
    (prisma as unknown as { productWarehouse: { findFirst: jest.Mock } }).productWarehouse = {
      findFirst: jest.fn().mockResolvedValue(pw),
    };

    const updatedPw = { id: PW_ID, productId: PROD_ID, productVariantId: null, warehouseId: WH_ID, quantity: new Decimal('15'), version: 1 };
    pwService.adjustStock.mockResolvedValue(updatedPw);
    prisma.adjustment.update.mockResolvedValue({});
    prisma.adjustment.findUniqueOrThrow.mockResolvedValue(makeAdjustment({ status: 'VALIDATED' }));

    const result = await service.validate(ADJ_ID, ORG_A);

    expect(pwService.adjustStock).toHaveBeenCalledTimes(1);
    expect(pwService.adjustStock).toHaveBeenCalledWith(
      expect.anything(),
      PW_ID,
      ORG_A,
      expect.any(Decimal),
      0,
    );
    expect(result.status).toBe('VALIDATED');
  });

  it('validate : lève BadRequestException si ajustement déjà VALIDATED', async () => {
    prisma.adjustment.findUnique.mockResolvedValue(makeAdjustment({ status: 'VALIDATED' }));

    await expect(service.validate(ADJ_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('validate : propage ConflictException si OptimisticLockException levée', async () => {
    const adj = makeAdjustment();
    prisma.adjustment.findUnique.mockResolvedValue(adj);

    (prisma as unknown as { productWarehouse: { findFirst: jest.Mock } }).productWarehouse = {
      findFirst: jest.fn().mockResolvedValue({ id: PW_ID, version: 0, product: { name: 'P', stockAlert: 0 } }),
    };

    pwService.adjustStock.mockRejectedValue(
      new OptimisticLockException(PW_ID, 0, 1),
    );

    await expect(service.validate(ADJ_ID, ORG_A)).rejects.toThrow(ConflictException);
  });

  it("validate ADDITION : émet stock:updated avec la nouvelle quantité", async () => {
    const adj = makeAdjustment();
    prisma.adjustment.findUnique.mockResolvedValue(adj);

    (prisma as unknown as { productWarehouse: { findFirst: jest.Mock } }).productWarehouse = {
      findFirst: jest.fn().mockResolvedValue({ id: PW_ID, version: 0, product: { name: 'Prod', stockAlert: 0 } }),
    };

    pwService.adjustStock.mockResolvedValue({
      id: PW_ID, productId: PROD_ID, productVariantId: null,
      warehouseId: WH_ID, quantity: new Decimal('15'), version: 1,
    });
    prisma.adjustment.update.mockResolvedValue({});
    prisma.adjustment.findUniqueOrThrow.mockResolvedValue(makeAdjustment({ status: 'VALIDATED' }));

    await service.validate(ADJ_ID, ORG_A);

    expect(realtime.server.to).toHaveBeenCalledWith(`org:${ORG_A}`);
    expect(toEmit).toHaveBeenCalledWith('stock:updated', expect.objectContaining({
      warehouseId: WH_ID,
      products: expect.arrayContaining([expect.objectContaining({ productId: PROD_ID })]),
    }));
  });

  it('validate SOUSTRACTION sous le seuil : émet stock:lowAlert', async () => {
    const adj = makeAdjustment({
      details: [{
        id: DETAIL_ID, productId: PROD_ID, productVariantId: null,
        type: 'SOUSTRACTION', quantity: new Decimal('8'), unitCost: new Decimal('0'),
      }],
    });
    prisma.adjustment.findUnique.mockResolvedValue(adj);

    (prisma as unknown as { productWarehouse: { findFirst: jest.Mock } }).productWarehouse = {
      findFirst: jest.fn().mockResolvedValue({ id: PW_ID, version: 0, product: { name: 'Prod A', stockAlert: 5 } }),
    };

    // Nouvelle quantité = 3, seuil = 5 → lowAlert doit être émis
    pwService.adjustStock.mockResolvedValue({
      id: PW_ID, productId: PROD_ID, productVariantId: null,
      warehouseId: WH_ID, quantity: new Decimal('3'), version: 1,
    });
    prisma.adjustment.update.mockResolvedValue({});
    prisma.adjustment.findUniqueOrThrow.mockResolvedValue(makeAdjustment({ status: 'VALIDATED' }));

    await service.validate(ADJ_ID, ORG_A);

    expect(toEmit).toHaveBeenCalledWith('stock:lowAlert', expect.objectContaining({
      productId: PROD_ID,
      productName: 'Prod A',
      threshold: 5,
    }));
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it('remove : lève BadRequestException si ajustement VALIDATED', async () => {
    prisma.adjustment.findUnique.mockResolvedValue(makeAdjustment({ status: 'VALIDATED' }));

    await expect(service.remove(ADJ_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('remove : soft-delete un ajustement DRAFT', async () => {
    prisma.adjustment.findUnique.mockResolvedValue(makeAdjustment());
    prisma.adjustment.update.mockResolvedValue({});

    await service.remove(ADJ_ID, ORG_A);

    expect(prisma.adjustment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });
});
