import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { PurchaseService } from '../purchase.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ProductWarehouseService, OptimisticLockException } from '../../inventory/product-warehouse.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A       = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B       = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID     = 'user0000-0000-0000-0000-000000000001';
const OTHER_USER  = 'user0000-0000-0000-0000-000000000002';
const PROVIDER_ID = 'prov0001-0000-0000-0000-000000000001';
const WH_ID       = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID     = 'prod0000-0000-0000-0000-000000000001';
const PURCHASE_ID = 'purc0001-0000-0000-0000-000000000001';
const PW_ID       = 'pw000001-0000-0000-0000-000000000001';
const NEW_PW_ID   = 'pw000002-0000-0000-0000-000000000002';
const UNIT_PIECE  = 'unit0001-0000-0000-0000-000000000001';
const UNIT_CARTON = 'unit0002-0000-0000-0000-000000000002';
const REF         = 'ACH-2026-000001';

function makePurchase(overrides: Partial<{
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
    id: PURCHASE_ID,
    organizationId: ORG_A,
    reference: REF,
    date: new Date('2026-07-26'),
    userId: USER_ID,
    providerId: PROVIDER_ID,
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
        purchaseUnitId: null,
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

describe('PurchaseService', () => {
  let service: PurchaseService;

  let prisma: {
    provider: { findUnique: jest.Mock };
    warehouse: { findUnique: jest.Mock };
    product: { findMany: jest.Mock };
    productVariant: { findMany: jest.Mock };
    unit: { findMany: jest.Mock };
    productWarehouse: { findFirst: jest.Mock; create: jest.Mock };
    purchase: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    purchaseDetail: { deleteMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };
  let productWarehouseService: { adjustStock: jest.Mock };
  let emailQueue: { add: jest.Mock };
  let smsQueue: { add: jest.Mock };
  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      provider: { findUnique: jest.fn() },
      warehouse: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      productVariant: { findMany: jest.fn() },
      unit: { findMany: jest.fn() },
      productWarehouse: { findFirst: jest.fn(), create: jest.fn() },
      purchase: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      purchaseDetail: { deleteMany: jest.fn(), createMany: jest.fn() },
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
    const emailQueueMock = { add: jest.fn().mockResolvedValue(undefined) };
    const smsQueueMock = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
        { provide: RealtimeGateway, useValue: rtMock },
        { provide: ProductWarehouseService, useValue: pwMock },
        { provide: getQueueToken('email'), useValue: emailQueueMock },
        { provide: getQueueToken('sms'), useValue: smsQueueMock },
      ],
    }).compile();

    service = module.get(PurchaseService);
    prisma = prismaMock;
    documentCounter = dcMock;
    productWarehouseService = pwMock;
    emailQueue = emailQueueMock;
    smsQueue = smsQueueMock;
  });

  afterEach(() => jest.clearAllMocks());

  function baseDto(overrides: Record<string, unknown> = {}) {
    return {
      providerId: PROVIDER_ID,
      warehouseId: WH_ID,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ productId: PROD_ID, price: '15000', quantity: '1' }],
      ...overrides,
    };
  }

  function mockOwnershipOk() {
    prisma.provider.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, organizationId: ORG_A, deletedAt: null }]);
    prisma.productVariant.findMany.mockResolvedValue([]);
    prisma.unit.findMany.mockResolvedValue([]);
  }

  // ─── create ──────────────────────────────────────────────────────────────

  it('create : crée un achat PENDING avec référence ACH-… et grandTotal calculé (Decimal)', async () => {
    mockOwnershipOk();
    prisma.purchase.create.mockResolvedValue(makePurchase());

    const result = await service.create(ORG_A, USER_ID, baseDto());

    expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
    expect(prisma.purchase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          reference: REF,
          paymentStatus: 'UNPAID',
        }),
      }),
    );
    // subTotal = 15000 × 1 = 15000, pas de taxe/remise → grandTotal = 15000
    const createArgs = prisma.purchase.create.mock.calls[0][0] as {
      data: { grandTotal: Decimal };
    };
    expect(createArgs.data.grandTotal.toString()).toBe('15000');
    expect(result.reference).toBe(REF);
  });

  it('create : taxe en percentage vs fixed → totaux de ligne distincts', async () => {
    mockOwnershipOk();
    prisma.purchase.create.mockResolvedValue(makePurchase());

    await service.create(
      ORG_A,
      USER_ID,
      baseDto({
        details: [{ productId: PROD_ID, price: '1000', quantity: '2', taxAmount: '10', taxMethod: 'percentage' }],
      }),
    );
    const percentArgs = prisma.purchase.create.mock.calls[0][0] as {
      data: { details: { create: { total: Decimal }[] } };
    };
    // subTotal = 2000, taxe 10% = 200 → total ligne = 2200
    expect(percentArgs.data.details.create[0]!.total.toString()).toBe('2200');

    jest.clearAllMocks();
    mockOwnershipOk();
    prisma.purchase.create.mockResolvedValue(makePurchase());

    await service.create(
      ORG_A,
      USER_ID,
      baseDto({
        details: [{ productId: PROD_ID, price: '1000', quantity: '2', taxAmount: '10', taxMethod: 'fixed' }],
      }),
    );
    const fixedArgs = prisma.purchase.create.mock.calls[0][0] as {
      data: { details: { create: { total: Decimal }[] } };
    };
    // subTotal = 2000, taxe fixe = 10 → total ligne = 2010
    expect(fixedArgs.data.details.create[0]!.total.toString()).toBe('2010');
  });

  it('create : discount global déduit du grandTotal', async () => {
    mockOwnershipOk();
    prisma.purchase.create.mockResolvedValue(makePurchase());

    await service.create(
      ORG_A,
      USER_ID,
      baseDto({
        details: [{ productId: PROD_ID, price: '10000', quantity: '1' }],
        discount: '1500',
        shipping: '500',
      }),
    );

    const createArgs = prisma.purchase.create.mock.calls[0][0] as {
      data: { grandTotal: Decimal };
    };
    // sumLines = 10000, taxGlobal = 0, discount = 1500, shipping = 500 → 10000 - 1500 + 500 = 9000
    expect(createArgs.data.grandTotal.toString()).toBe('9000');
  });

  it("create : lève ForbiddenException si le providerId appartient à une autre org", async () => {
    prisma.provider.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

    await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
  });

  it("create : lève ForbiddenException si le warehouseId appartient à une autre org", async () => {
    prisma.provider.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_B, deletedAt: null });

    await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
  });

  it("create : lève ForbiddenException si le produit appartient à une autre org (IDOR)", async () => {
    prisma.provider.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.warehouse.findUnique.mockResolvedValue({ organizationId: ORG_A, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, organizationId: ORG_B, deletedAt: null }]);

    await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
  });

  // ─── findAll ─────────────────────────────────────────────────────────────

  it('findAll : viewAll=false injecte un filtre userId', async () => {
    prisma.purchase.findMany.mockResolvedValue([]);
    prisma.purchase.count.mockResolvedValue(0);

    await service.findAll(ORG_A, OTHER_USER, false, 1, 20);

    expect(prisma.purchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_A, userId: OTHER_USER }),
      }),
    );
  });

  it('findAll : viewAll=true ne filtre pas par userId', async () => {
    prisma.purchase.findMany.mockResolvedValue([]);
    prisma.purchase.count.mockResolvedValue(0);

    await service.findAll(ORG_A, OTHER_USER, true, 1, 20);

    const call = prisma.purchase.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty('userId');
  });

  // ─── update ──────────────────────────────────────────────────────────────

  it('update : lève BadRequestException si l\'achat est COMPLETED', async () => {
    prisma.purchase.findUnique.mockResolvedValue(makePurchase({ status: 'COMPLETED' }));

    await expect(
      service.update(PURCHASE_ID, ORG_A, { notes: 'x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('update : lève NotFoundException si l\'achat est introuvable', async () => {
    prisma.purchase.findUnique.mockResolvedValue(null);

    await expect(service.update(PURCHASE_ID, ORG_A, { notes: 'x' })).rejects.toThrow(NotFoundException);
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it('remove : lève BadRequestException si l\'achat est COMPLETED', async () => {
    prisma.purchase.findUnique.mockResolvedValue(makePurchase({ status: 'COMPLETED' }));

    await expect(service.remove(PURCHASE_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('remove : soft-delete un achat PENDING', async () => {
    prisma.purchase.findUnique.mockResolvedValue(makePurchase({ status: 'PENDING' }));
    prisma.purchase.update.mockResolvedValue({});

    await service.remove(PURCHASE_ID, ORG_A);

    expect(prisma.purchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PURCHASE_ID },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  // ─── validate ────────────────────────────────────────────────────────────

  describe('validate', () => {
    /** Construit un achat PENDING avec des lignes personnalisées pour les tests de validate(). */
    function makeValidatePurchase(details: Record<string, unknown>[]) {
      return makePurchase({ status: 'PENDING', details });
    }

    function mockValidateHappyPath(opts: { pwQuantity: string; newQuantity: string }) {
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal(opts.pwQuantity),
      });
      productWarehouseService.adjustStock.mockResolvedValue({
        id: PW_ID,
        productId: PROD_ID,
        productVariantId: null,
        warehouseId: WH_ID,
        quantity: new Decimal(opts.newQuantity),
        version: 1,
      });
      prisma.purchase.update.mockResolvedValue({});
      prisma.purchase.findUniqueOrThrow.mockResolvedValue(makePurchase({ status: 'COMPLETED' }));
    }

    it('incrémente correctement le stock d\'une ligne simple', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('3') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      mockValidateHappyPath({ pwQuantity: '10', newQuantity: '13' });

      const result = await service.validate(PURCHASE_ID, ORG_A);

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      const [, pwId, org, delta, version] = productWarehouseService.adjustStock.mock.calls[0] as [
        unknown, string, string, Decimal, number,
      ];
      expect(pwId).toBe(PW_ID);
      expect(org).toBe(ORG_A);
      expect(delta.toString()).toBe('3'); // positif — incrément, inverse d'une vente
      expect(version).toBe(0);
      expect(prisma.purchase.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PURCHASE_ID }, data: { status: 'COMPLETED' } }),
      );
      expect(result.status).toBe('COMPLETED');
    });

    it('convertit la quantité via purchaseUnitId (2 cartons × 12 = 24 pièces incrémentées)', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: UNIT_CARTON, quantity: new Decimal('2') },
        ]),
      );
      // Le produit est stocké en pièces — l'unité d'achat (carton) diffère → conversion.
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([
        { id: UNIT_CARTON, operator: '*', operatorValue: new Decimal('12') },
      ]);
      mockValidateHappyPath({ pwQuantity: '100', newQuantity: '124' });

      await service.validate(PURCHASE_ID, ORG_A);

      const [, , , delta] = productWarehouseService.adjustStock.mock.calls[0] as [unknown, unknown, unknown, Decimal];
      // 2 cartons × 12 = 24 pièces → incrément de 24
      expect(delta.toString()).toBe('24');
    });

    it('Unit mal configurée (operatorValue "0", operator "*") → BadRequestException, aucun appel à adjustStock', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: UNIT_CARTON, quantity: new Decimal('2') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      // operatorValue à 0 : 2 × 0 = 0 → incrément silencieusement nul si non gardé.
      prisma.unit.findMany.mockResolvedValue([
        { id: UNIT_CARTON, operator: '*', operatorValue: new Decimal('0') },
      ]);

      await expect(service.validate(PURCHASE_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('Unit mal configurée (operatorValue "0", operator "/") → BadRequestException (division par zéro → Infinity non fini)', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: UNIT_CARTON, quantity: new Decimal('2') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      // operatorValue à 0 avec "/" : 2 ÷ 0 = Infinity (decimal.js ne lève pas d'exception).
      prisma.unit.findMany.mockResolvedValue([
        { id: UNIT_CARTON, operator: '/', operatorValue: new Decimal('0') },
      ]);

      await expect(service.validate(PURCHASE_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('deux lignes du même produit → un seul appel à adjustStock avec la quantité cumulée', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('2') },
          { id: 'det2', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('3') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      mockValidateHappyPath({ pwQuantity: '20', newQuantity: '25' });

      await service.validate(PURCHASE_ID, ORG_A);

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      const [, , , delta] = productWarehouseService.adjustStock.mock.calls[0] as [unknown, unknown, unknown, Decimal];
      // 2 + 3 = 5 cumulé, un seul mouvement de +5 — jamais deux appels de +2 puis +3.
      expect(delta.toString()).toBe('5');
    });

    it('ProductWarehouse absent → créé dans la transaction puis incrémenté (version attendue 0)', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('8') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      // Stock inexistant avant validate() : findFirst ne retourne rien.
      prisma.productWarehouse.findFirst.mockResolvedValue(null);
      prisma.productWarehouse.create.mockResolvedValue({ id: NEW_PW_ID, version: 0 });
      productWarehouseService.adjustStock.mockResolvedValue({
        id: NEW_PW_ID,
        productId: PROD_ID,
        productVariantId: null,
        warehouseId: WH_ID,
        quantity: new Decimal('8'),
        version: 1,
      });
      prisma.purchase.update.mockResolvedValue({});
      prisma.purchase.findUniqueOrThrow.mockResolvedValue(makePurchase({ status: 'COMPLETED' }));

      const result = await service.validate(PURCHASE_ID, ORG_A);

      expect(prisma.productWarehouse.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: PROD_ID,
            warehouseId: WH_ID,
            productVariantId: null,
            quantity: expect.any(Decimal),
            version: 0,
          }),
        }),
      );
      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      const [, pwId, org, delta, version] = productWarehouseService.adjustStock.mock.calls[0] as [
        unknown, string, string, Decimal, number,
      ];
      expect(pwId).toBe(NEW_PW_ID);
      expect(org).toBe(ORG_A);
      expect(delta.toString()).toBe('8'); // quantité exacte de la ligne, aucune ligne préexistante
      expect(version).toBe(0);
      expect(result.status).toBe('COMPLETED');
    });

    it('statut déjà COMPLETED → BadRequestException (pas de revalidation)', async () => {
      prisma.purchase.findUnique.mockResolvedValue(makePurchase({ status: 'COMPLETED' }));

      await expect(service.validate(PURCHASE_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it("achat d'une autre organisation → ForbiddenException", async () => {
      prisma.purchase.findUnique.mockResolvedValue(makePurchase({ organizationId: ORG_B, status: 'PENDING' }));

      await expect(service.validate(PURCHASE_ID, ORG_A)).rejects.toThrow(ForbiddenException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('achat introuvable → NotFoundException', async () => {
      prisma.purchase.findUnique.mockResolvedValue(null);

      await expect(service.validate(PURCHASE_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('émet stock:updated après incrément (jamais stock:lowAlert)', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('2') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      mockValidateHappyPath({ pwQuantity: '8', newQuantity: '10' });

      await service.validate(PURCHASE_ID, ORG_A);

      expect(toEmit).toHaveBeenCalledWith(
        'stock:updated',
        expect.objectContaining({ warehouseId: WH_ID }),
      );
      expect(toEmit).not.toHaveBeenCalledWith('stock:lowAlert', expect.anything());
    });

    it('lève ConflictException si adjustStock lève OptimisticLockException (conflit de version)', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('1') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('10'),
      });
      productWarehouseService.adjustStock.mockRejectedValue(new OptimisticLockException(PW_ID, 0, 1));

      await expect(service.validate(PURCHASE_ID, ORG_A)).rejects.toThrow(ConflictException);
    });

    // ─── retry sur conflit de concurrence (TÂCHE 1) ─────────────────────────
    // Un incrément d'achat est toujours fusionnable (cf. JSDoc de validate()) : contrairement
    // à SaleService.validate(), un conflit de version optimiste ne doit pas remonter un 409
    // dès la première occurrence — il doit être retenté (jusqu'à MAX_VALIDATE_ATTEMPTS = 5).

    it('retry : OptimisticLockException une seule fois puis succès → COMPLETED sans exception propagée', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('5') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('10'),
      });
      productWarehouseService.adjustStock
        .mockRejectedValueOnce(new OptimisticLockException(PW_ID, 0, 1))
        .mockResolvedValueOnce({
          id: PW_ID,
          productId: PROD_ID,
          productVariantId: null,
          warehouseId: WH_ID,
          quantity: new Decimal('15'),
          version: 1,
        });
      prisma.purchase.update.mockResolvedValue({});
      prisma.purchase.findUniqueOrThrow.mockResolvedValue(makePurchase({ status: 'COMPLETED' }));

      const result = await service.validate(PURCHASE_ID, ORG_A);

      // 2 tentatives : la 1re échoue (conflit), la 2e réussit — jamais d'exception propagée.
      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(2);
      expect(prisma.purchase.update).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('COMPLETED');
    });

    it('retry : conflit de sérialisation Prisma P2034 une seule fois puis succès → COMPLETED', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('2') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('10'),
      });
      const p2034 = new Prisma.PrismaClientKnownRequestError('could not serialize access', {
        code: 'P2034',
        clientVersion: '5.22.0',
      });
      productWarehouseService.adjustStock
        .mockRejectedValueOnce(p2034)
        .mockResolvedValueOnce({
          id: PW_ID,
          productId: PROD_ID,
          productVariantId: null,
          warehouseId: WH_ID,
          quantity: new Decimal('12'),
          version: 1,
        });
      prisma.purchase.update.mockResolvedValue({});
      prisma.purchase.findUniqueOrThrow.mockResolvedValue(makePurchase({ status: 'COMPLETED' }));

      const result = await service.validate(PURCHASE_ID, ORG_A);

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('COMPLETED');
    });

    it('retry : conflit persistant sur les 5 tentatives → ConflictException finale, aucune régression de comportement de repli', async () => {
      prisma.purchase.findUnique.mockResolvedValue(
        makeValidatePurchase([
          { id: 'det1', productId: PROD_ID, productVariantId: null, purchaseUnitId: null, quantity: new Decimal('1') },
        ]),
      );
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('10'),
      });
      productWarehouseService.adjustStock.mockRejectedValue(new OptimisticLockException(PW_ID, 0, 1));

      await expect(service.validate(PURCHASE_ID, ORG_A)).rejects.toThrow(ConflictException);
      // 5 tentatives exactement — aucune 6e, le plafond MAX_VALIDATE_ATTEMPTS est respecté.
      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(5);
      expect(prisma.purchase.update).not.toHaveBeenCalled();
    });

    it('retry : une NotFoundException/BadRequestException n\'est jamais retentée (relancée à la 1re tentative)', async () => {
      prisma.purchase.findUnique.mockResolvedValue(makePurchase({ status: 'COMPLETED' }));

      await expect(service.validate(PURCHASE_ID, ORG_A)).rejects.toThrow(BadRequestException);
      // purchase.findUnique n'est appelé qu'une seule fois : pas de nouvelle tentative sur
      // une exception métier (à l'inverse d'un conflit de concurrence).
      expect(prisma.purchase.findUnique).toHaveBeenCalledTimes(1);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('enfile un job purchase.sendEmail sur la file email quand le fournisseur a un email', async () => {
      prisma.purchase.findUnique.mockResolvedValue({
        organizationId: ORG_A,
        deletedAt: null,
        provider: { email: 'fournisseur@example.com', phone: null },
      });

      const result = await service.send(PURCHASE_ID, ORG_A, 'email');

      expect(result).toEqual({ status: 'queued' });
      expect(emailQueue.add).toHaveBeenCalledWith('purchase.sendEmail', {
        organizationId: ORG_A,
        purchaseId: PURCHASE_ID,
        to: 'fournisseur@example.com',
      });
    });

    it("lève BadRequestException si le fournisseur n'a pas d'adresse email", async () => {
      prisma.purchase.findUnique.mockResolvedValue({
        organizationId: ORG_A,
        deletedAt: null,
        provider: { email: null, phone: null },
      });

      await expect(service.send(PURCHASE_ID, ORG_A, 'email')).rejects.toThrow(BadRequestException);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('enfile un job purchase.sendSms sur la file sms quand le fournisseur a un téléphone', async () => {
      prisma.purchase.findUnique.mockResolvedValue({
        organizationId: ORG_A,
        deletedAt: null,
        provider: { email: null, phone: '+237600000000' },
      });

      const result = await service.send(PURCHASE_ID, ORG_A, 'sms');

      expect(result).toEqual({ status: 'queued' });
      expect(smsQueue.add).toHaveBeenCalledWith('purchase.sendSms', {
        organizationId: ORG_A,
        purchaseId: PURCHASE_ID,
        to: '+237600000000',
      });
    });

    it("lève BadRequestException si le fournisseur n'a pas de numéro de téléphone", async () => {
      prisma.purchase.findUnique.mockResolvedValue({
        organizationId: ORG_A,
        deletedAt: null,
        provider: { email: 'fournisseur@example.com', phone: null },
      });

      await expect(service.send(PURCHASE_ID, ORG_A, 'sms')).rejects.toThrow(BadRequestException);
      expect(smsQueue.add).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si l\'achat est introuvable ou soft-supprimé', async () => {
      prisma.purchase.findUnique.mockResolvedValue(null);

      await expect(service.send(PURCHASE_ID, ORG_A, 'email')).rejects.toThrow(NotFoundException);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si l'achat appartient à une autre organisation (anti-IDOR)", async () => {
      prisma.purchase.findUnique.mockResolvedValue({
        organizationId: ORG_B,
        deletedAt: null,
        provider: { email: 'fournisseur@example.com', phone: null },
      });

      await expect(service.send(PURCHASE_ID, ORG_A, 'email')).rejects.toThrow(ForbiddenException);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });
  });
});
