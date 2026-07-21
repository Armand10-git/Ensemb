import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { ProductWarehouseService, OptimisticLockException } from '../product-warehouse.service';
import { PrismaService } from '../../../common/prisma.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B = 'bbbb0000-0000-0000-0000-000000000002';
const PROD_ID  = 'prod0000-0000-0000-0000-000000000001';
const WH_ID_1  = 'wh000001-0000-0000-0000-000000000001';
const WH_ID_2  = 'wh000002-0000-0000-0000-000000000002';
const PW_ID    = 'pw000001-0000-0000-0000-000000000001';

function makeStock(overrides: {
  id?: string;
  productId?: string;
  warehouseId?: string;
  productVariantId?: string | null;
  quantity?: Decimal;
  version?: number;
  warehouseName?: string;
} = {}) {
  return {
    id: PW_ID,
    productId: PROD_ID,
    warehouseId: WH_ID_1,
    productVariantId: null,
    quantity: new Decimal('10'),
    version: 0,
    warehouse: { name: overrides.warehouseName ?? 'Entrepôt principal' },
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('ProductWarehouseService', () => {
  let service: ProductWarehouseService;
  let prisma: {
    product: { findUnique: jest.Mock };
    warehouse: { findUnique: jest.Mock };
    productWarehouse: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    const mock = {
      product: { findUnique: jest.fn() },
      warehouse: { findUnique: jest.fn() },
      productWarehouse: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        ProductWarehouseService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();

    service = module.get(ProductWarehouseService);
    prisma = mock;
  });

  // ─── findByProduct : scoping org + ownership ─────────────────────────────

  it('findByProduct : retourne les stocks scopés au produit', async () => {
    prisma.product.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    const rows = [makeStock(), makeStock({ id: 'pw2', warehouseId: WH_ID_2, quantity: new Decimal('5'), warehouseName: 'Entrepôt secondaire' })];
    prisma.productWarehouse.findMany.mockResolvedValue(rows);

    const result = await service.findByProduct(PROD_ID, ORG_A);

    expect(result).toHaveLength(2);
    expect(result[0]!.warehouseName).toBe('Entrepôt principal');
    expect(result[1]!.warehouseName).toBe('Entrepôt secondaire');
    expect(prisma.product.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PROD_ID } }),
    );
  });

  it('findByProduct : lève ForbiddenException si produit appartient à une autre org', async () => {
    prisma.product.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

    await expect(service.findByProduct(PROD_ID, ORG_A)).rejects.toThrow(ForbiddenException);
  });

  it('findByProduct : lève NotFoundException si produit soft-deleted', async () => {
    prisma.product.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: new Date() });

    await expect(service.findByProduct(PROD_ID, ORG_A)).rejects.toThrow(NotFoundException);
  });

  // ─── initStock : idempotent ───────────────────────────────────────────────

  it('initStock : idempotent — retourne le stock existant sans créer de doublon', async () => {
    prisma.product.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });

    const existing = makeStock();
    prisma.productWarehouse.findFirst.mockResolvedValue(existing);

    const result = await service.initStock(PROD_ID, WH_ID_1, ORG_A);

    expect(prisma.productWarehouse.create).not.toHaveBeenCalled();
    expect(result.id).toBe(PW_ID);
    expect(result.quantity.toString()).toBe('10');
  });

  it('initStock : crée un nouveau stock si absent (quantity=0, version=0)', async () => {
    prisma.product.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.productWarehouse.findFirst.mockResolvedValue(null);

    const created = makeStock({ quantity: new Decimal('0'), version: 0 });
    prisma.productWarehouse.create.mockResolvedValue(created);

    const result = await service.initStock(PROD_ID, WH_ID_1, ORG_A);

    expect(prisma.productWarehouse.create).toHaveBeenCalled();
    expect(result.version).toBe(0);
  });

  // ─── getStockSummary : somme multi-entrepôts ─────────────────────────────

  it('getStockSummary : somme correcte multi-entrepôts', async () => {
    prisma.product.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.productWarehouse.findMany.mockResolvedValue([
      makeStock({ warehouseId: WH_ID_1, quantity: new Decimal('10') }),
      makeStock({ id: 'pw2', warehouseId: WH_ID_2, quantity: new Decimal('5.5') }),
    ]);

    const summary = await service.getStockSummary(PROD_ID, ORG_A);

    expect(summary.totalQuantity.toString()).toBe('15.5');
    expect(summary.byWarehouse).toHaveLength(2);
  });

  // ─── adjustStock : verrouillage optimiste ────────────────────────────────

  it('adjustStock : lève OptimisticLockException si version incorrecte', async () => {
    const txMock = {
      productWarehouse: {
        findUnique: jest.fn().mockResolvedValue({ version: 2 }),
        update: jest.fn(),
      },
    };

    await expect(
      service.adjustStock(txMock as never, PW_ID, new Decimal('1'), 0),
    ).rejects.toThrow(OptimisticLockException);

    expect(txMock.productWarehouse.update).not.toHaveBeenCalled();
  });

  it('adjustStock : met à jour quantity+version si version correcte', async () => {
    const updated = {
      id: PW_ID,
      productId: PROD_ID,
      productVariantId: null,
      warehouseId: WH_ID_1,
      quantity: new Decimal('11'),
      version: 1,
    };

    const txMock = {
      productWarehouse: {
        findUnique: jest.fn().mockResolvedValue({ version: 0 }),
        update: jest.fn().mockResolvedValue(updated),
      },
    };

    const result = await service.adjustStock(txMock as never, PW_ID, new Decimal('1'), 0);

    expect(result.version).toBe(1);
    expect(txMock.productWarehouse.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { quantity: { increment: expect.anything() }, version: { increment: 1 } },
      }),
    );
  });
});
