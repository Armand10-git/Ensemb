import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Decimal } from '@prisma/client/runtime/library';
import { PurchaseReturnService } from '../purchase-return.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ProductWarehouseService, OptimisticLockException } from '../../inventory/product-warehouse.service';
import { NotificationService } from '../../notifications/notification.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A         = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B         = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID       = 'user0000-0000-0000-0000-000000000001';
const WH_ID         = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID       = 'prod0000-0000-0000-0000-000000000001';
const PURCHASE_ID   = 'purc0001-0000-0000-0000-000000000001';
const OTHER_PURCHASE_ID = 'purc0002-0000-0000-0000-000000000002';
const PURCHASE_DETAIL_ID = 'pdet0001-0000-0000-0000-000000000001';
const PURCHASE_RETURN_ID = 'pret0001-0000-0000-0000-000000000001';
const PW_ID         = 'pw000001-0000-0000-0000-000000000001';
const UNIT_PIECE    = 'unit0001-0000-0000-0000-000000000001';
const UNIT_CARTON   = 'unit0002-0000-0000-0000-000000000002';
const REF           = 'RAC-2026-000001';

function makePurchaseReturn(overrides: Record<string, unknown> = {}) {
  return {
    id: PURCHASE_RETURN_ID,
    organizationId: ORG_A,
    reference: REF,
    date: new Date('2026-07-26'),
    userId: USER_ID,
    purchaseId: PURCHASE_ID,
    warehouseId: WH_ID,
    taxRate: new Decimal('0'),
    taxAmount: new Decimal('0'),
    discount: new Decimal('0'),
    shipping: new Decimal('0'),
    grandTotal: new Decimal('6000'),
    paidAmount: new Decimal('0'),
    paymentStatus: 'UNPAID',
    status: 'PENDING',
    notes: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    details: [],
    ...overrides,
  };
}

describe('PurchaseReturnService', () => {
  let service: PurchaseReturnService;

  let prisma: {
    purchase: { findUnique: jest.Mock };
    purchaseDetail: { findMany: jest.Mock; findUnique: jest.Mock };
    purchaseReturnDetail: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    unit: { findMany: jest.Mock };
    productWarehouse: { findFirst: jest.Mock };
    purchaseReturn: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };
  let productWarehouseService: { adjustStock: jest.Mock };
  let notificationService: { createForOrg: jest.Mock };
  let emailQueue: { add: jest.Mock };
  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      purchase: { findUnique: jest.fn() },
      purchaseDetail: { findMany: jest.fn(), findUnique: jest.fn() },
      purchaseReturnDetail: { findMany: jest.fn() },
      product: { findMany: jest.fn() },
      unit: { findMany: jest.fn() },
      productWarehouse: { findFirst: jest.fn() },
      purchaseReturn: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
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
    const rtMock = { server: { to: jest.fn().mockReturnValue({ emit: toEmit }) } };
    const pwMock = { adjustStock: jest.fn() };
    const notifMock = { createForOrg: jest.fn().mockResolvedValue(undefined) };
    const emailQueueMock = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseReturnService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
        { provide: RealtimeGateway, useValue: rtMock },
        { provide: ProductWarehouseService, useValue: pwMock },
        { provide: NotificationService, useValue: notifMock },
        { provide: getQueueToken('email'), useValue: emailQueueMock },
      ],
    }).compile();

    service = module.get(PurchaseReturnService);
    prisma = prismaMock;
    documentCounter = dcMock;
    productWarehouseService = pwMock;
    notificationService = notifMock;
    emailQueue = emailQueueMock;
  });

  afterEach(() => jest.clearAllMocks());

  function baseDto(overrides: Record<string, unknown> = {}) {
    return {
      purchaseId: PURCHASE_ID,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ purchaseDetailId: PURCHASE_DETAIL_ID, quantity: '3' }],
      ...overrides,
    };
  }

  function mockPurchaseOk(status = 'COMPLETED') {
    prisma.purchase.findUnique.mockResolvedValue({
      id: PURCHASE_ID,
      organizationId: ORG_A,
      deletedAt: null,
      status,
      warehouseId: WH_ID,
    });
  }

  function mockPurchaseDetailSource(overrides: Record<string, unknown> = {}) {
    prisma.purchaseDetail.findMany.mockResolvedValue([
      {
        id: PURCHASE_DETAIL_ID,
        purchaseId: PURCHASE_ID,
        productId: PROD_ID,
        productVariantId: null,
        purchaseUnitId: null,
        price: new Decimal('1000'),
        taxAmount: new Decimal('0'),
        taxMethod: 'percentage',
        discount: new Decimal('0'),
        discountMethod: 'percentage',
        quantity: new Decimal('10'),
        product: { unitId: UNIT_PIECE },
        ...overrides,
      },
    ]);
  }

  // ─── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('copie price/taxAmount/taxMethod/discount/discountMethod depuis la PurchaseDetail source (jamais du DTO)', async () => {
      mockPurchaseOk();
      mockPurchaseDetailSource({
        price: new Decimal('1000'),
        taxAmount: new Decimal('80'),
        taxMethod: 'fixed',
        discount: new Decimal('20'),
        discountMethod: 'fixed',
        quantity: new Decimal('10'),
      });
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.purchaseReturn.create.mockResolvedValue(makePurchaseReturn());

      await service.create(ORG_A, USER_ID, baseDto({ details: [{ purchaseDetailId: PURCHASE_DETAIL_ID, quantity: '2' }] }));

      const createArgs = prisma.purchaseReturn.create.mock.calls[0][0] as {
        data: { details: { create: { price: Decimal; taxAmount: Decimal; taxMethod: string; discount: Decimal; discountMethod: string; total: Decimal }[] } };
      };
      const line = createArgs.data.details.create[0]!;
      expect(line.price.toString()).toBe('1000');
      expect(line.taxAmount.toString()).toBe('80');
      expect(line.taxMethod).toBe('fixed');
      expect(line.discount.toString()).toBe('20');
      expect(line.discountMethod).toBe('fixed');
      // subTotal = 1000 × 2 = 2000, taxe fixe 80, remise fixe 20 → 2060
      expect(line.total.toString()).toBe('2060');
    });

    it("lève ForbiddenException si purchaseDetailId n'appartient pas au purchaseId déclaré (IDOR)", async () => {
      mockPurchaseOk();
      mockPurchaseDetailSource({ purchaseId: OTHER_PURCHASE_ID });
      prisma.unit.findMany.mockResolvedValue([]);

      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
      expect(prisma.purchaseReturn.create).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si returnUnitId appartient à une autre organisation (IDOR)", async () => {
      mockPurchaseOk();
      mockPurchaseDetailSource();
      prisma.unit.findMany.mockResolvedValue([
        { id: UNIT_CARTON, organizationId: ORG_B, operator: '*', operatorValue: new Decimal('12') },
      ]);

      await expect(
        service.create(
          ORG_A,
          USER_ID,
          baseDto({ details: [{ purchaseDetailId: PURCHASE_DETAIL_ID, quantity: '2', returnUnitId: UNIT_CARTON }] }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("lève BadRequestException si l'achat d'origine n'est pas COMPLETED", async () => {
      mockPurchaseOk('PENDING');

      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(BadRequestException);
      expect(prisma.purchaseReturn.create).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si l'achat appartient à une autre organisation", async () => {
      prisma.purchase.findUnique.mockResolvedValue({
        id: PURCHASE_ID,
        organizationId: ORG_B,
        deletedAt: null,
        status: 'COMPLETED',
        warehouseId: WH_ID,
      });

      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si l\'achat est introuvable', async () => {
      prisma.purchase.findUnique.mockResolvedValue(null);

      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(NotFoundException);
    });

    it('lève BadRequestException (best-effort) si la quantité retournée dépasse la quantité achetée sur cette ligne', async () => {
      mockPurchaseOk();
      mockPurchaseDetailSource({ quantity: new Decimal('5') });
      prisma.unit.findMany.mockResolvedValue([]);

      await expect(
        service.create(ORG_A, USER_ID, baseDto({ details: [{ purchaseDetailId: PURCHASE_DETAIL_ID, quantity: '6' }] })),
      ).rejects.toThrow(BadRequestException);
    });

    it('crée un retour PENDING avec référence RAC-… et warehouseId copié depuis l\'achat', async () => {
      mockPurchaseOk();
      mockPurchaseDetailSource();
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.purchaseReturn.create.mockResolvedValue(makePurchaseReturn());

      const result = await service.create(ORG_A, USER_ID, baseDto());

      expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
      expect(prisma.purchaseReturn.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING', warehouseId: WH_ID, reference: REF }),
        }),
      );
      expect(result.reference).toBe(REF);
    });
  });

  // ─── validate ────────────────────────────────────────────────────────────

  describe('validate', () => {
    function makeValidateReturn(details: Record<string, unknown>[], status = 'PENDING') {
      return makePurchaseReturn({ status, details });
    }

    function mockPurchaseDetailForCeiling(overrides: Record<string, unknown> = {}) {
      prisma.purchaseDetail.findUnique.mockResolvedValue({
        quantity: new Decimal('10'),
        purchaseUnitId: null,
        product: { unitId: UNIT_PIECE },
        ...overrides,
      });
    }

    function mockValidateHappyPath(opts: { pwQuantity: string; newQuantity: string }) {
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal(opts.pwQuantity),
        product: { stockAlert: 0, name: 'Produit' },
      });
      productWarehouseService.adjustStock.mockResolvedValue({
        id: PW_ID,
        productId: PROD_ID,
        productVariantId: null,
        warehouseId: WH_ID,
        quantity: new Decimal(opts.newQuantity),
        version: 1,
      });
      prisma.purchaseReturn.update.mockResolvedValue({});
      prisma.purchaseReturn.findUniqueOrThrow.mockResolvedValue(makePurchaseReturn({ status: 'COMPLETED' }));
    }

    it('rejette un retour non-PENDING (déjà COMPLETED)', async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValue(makeValidateReturn([], 'COMPLETED'));

      await expect(service.validate(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si le retour appartient à une autre organisation", async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValue(
        makePurchaseReturn({ organizationId: ORG_B, status: 'PENDING' }),
      );

      await expect(service.validate(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(ForbiddenException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('décrémente le stock (sens DECREMENT, mirror SaleService) sur une ligne simple', async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValue(
        makeValidateReturn([
          { purchaseDetailId: PURCHASE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('3') },
        ]),
      );
      mockPurchaseDetailForCeiling();
      prisma.purchaseReturnDetail.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      mockValidateHappyPath({ pwQuantity: '20', newQuantity: '17' });

      const result = await service.validate(PURCHASE_RETURN_ID, ORG_A);

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      const [, , , delta] = productWarehouseService.adjustStock.mock.calls[0] as [unknown, unknown, unknown, Decimal];
      // Retour fournisseur → décrément (delta négatif), mirror SaleService.validate().
      expect(delta.toString()).toBe('-3');
      expect(prisma.purchaseReturn.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PURCHASE_RETURN_ID }, data: { status: 'COMPLETED' } }),
      );
      expect(result.status).toBe('COMPLETED');
    });

    it('quantité demandée > stock disponible → BadRequestException, adjustStock jamais appelé', async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValue(
        makeValidateReturn([
          { purchaseDetailId: PURCHASE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('5') },
        ]),
      );
      mockPurchaseDetailForCeiling();
      prisma.purchaseReturnDetail.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('1'),
        product: { stockAlert: 0, name: 'Produit' },
      });

      await expect(service.validate(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('ProductWarehouse introuvable dans l\'entrepôt → NotFoundException (PAS de création automatique, contrairement à SaleReturn)', async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValue(
        makeValidateReturn([
          { purchaseDetailId: PURCHASE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('1') },
        ]),
      );
      mockPurchaseDetailForCeiling();
      prisma.purchaseReturnDetail.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue(null);

      await expect(service.validate(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(NotFoundException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it(
      'plafond cumulé AVEC conversion d\'unité — acheté en carton (1 carton = 12 pièces), retour ' +
        'exprimé en pièces : la comparaison se fait bien en unité de BASE (piège de conception)',
      async () => {
        prisma.purchaseReturn.findUnique.mockResolvedValue(
          makeValidateReturn([
            { purchaseDetailId: PURCHASE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('10') },
          ]),
        );
        mockPurchaseDetailForCeiling({ purchaseUnitId: UNIT_CARTON, quantity: new Decimal('1') });
        prisma.purchaseReturnDetail.findMany.mockResolvedValue([]);
        prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
        prisma.unit.findMany.mockResolvedValue([
          { id: UNIT_CARTON, operator: '*', operatorValue: new Decimal('12') },
        ]);
        mockValidateHappyPath({ pwQuantity: '50', newQuantity: '40' });

        await expect(service.validate(PURCHASE_RETURN_ID, ORG_A)).resolves.toBeDefined();
        expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'plafond cumulé — un retour COMPLETED existant (converti en base) + cette ligne dépasse la ' +
        'quantité achetée à l\'origine → BadRequestException',
      async () => {
        prisma.purchaseReturn.findUnique.mockResolvedValue(
          makeValidateReturn([
            { purchaseDetailId: PURCHASE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('1') },
          ]),
        );
        mockPurchaseDetailForCeiling({ purchaseUnitId: UNIT_CARTON, quantity: new Decimal('1') });
        prisma.purchaseReturnDetail.findMany.mockResolvedValue([
          { quantity: new Decimal('1'), returnUnitId: UNIT_CARTON },
        ]);
        prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
        prisma.unit.findMany.mockResolvedValue([
          { id: UNIT_CARTON, operator: '*', operatorValue: new Decimal('12') },
        ]);

        await expect(service.validate(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
        expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
      },
    );

    // ─── PAS de retry (mirror SaleService — écart assumé vs SaleReturnService) ────

    it('lève ConflictException IMMÉDIATEMENT sur un conflit de version — aucun retry (mirror SaleService)', async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValue(
        makeValidateReturn([
          { purchaseDetailId: PURCHASE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('1') },
        ]),
      );
      mockPurchaseDetailForCeiling();
      prisma.purchaseReturnDetail.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('10'),
        product: { stockAlert: 0, name: 'Produit' },
      });
      productWarehouseService.adjustStock.mockRejectedValue(new OptimisticLockException(PW_ID, 0, 1));

      await expect(service.validate(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(ConflictException);
      // Un seul appel — pas de retry, contrairement à SaleReturnService.validate().
      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
    });

    it('émet stock:lowAlert + NotificationService.createForOrg si le seuil est atteint après décrément', async () => {
      prisma.purchaseReturn.findUnique.mockResolvedValue(
        makeValidateReturn([
          { purchaseDetailId: PURCHASE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('7') },
        ]),
      );
      mockPurchaseDetailForCeiling();
      prisma.purchaseReturnDetail.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({
        id: PW_ID,
        version: 0,
        quantity: new Decimal('10'),
        product: { stockAlert: 5, name: 'Produit X' },
      });
      productWarehouseService.adjustStock.mockResolvedValue({
        id: PW_ID,
        productId: PROD_ID,
        productVariantId: null,
        warehouseId: WH_ID,
        quantity: new Decimal('3'),
        version: 1,
      });
      prisma.purchaseReturn.update.mockResolvedValue({});
      prisma.purchaseReturn.findUniqueOrThrow.mockResolvedValue(makePurchaseReturn({ status: 'COMPLETED' }));

      await service.validate(PURCHASE_RETURN_ID, ORG_A);

      expect(toEmit).toHaveBeenCalledWith('stock:lowAlert', expect.objectContaining({ productId: PROD_ID, threshold: 5 }));
      expect(notificationService.createForOrg).toHaveBeenCalledWith(
        ORG_A,
        'stock.lowAlert',
        expect.objectContaining({ productId: PROD_ID, productName: 'Produit X' }),
        'reports.quantityAlerts',
      );
    });
  });

  // ─── findAll ─────────────────────────────────────────────────────────────

  it('findAll : viewAll=false injecte un filtre userId', async () => {
    prisma.purchaseReturn.findMany.mockResolvedValue([]);
    prisma.purchaseReturn.count.mockResolvedValue(0);

    await service.findAll(ORG_A, USER_ID, false, 1, 20);

    expect(prisma.purchaseReturn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_A, userId: USER_ID }) }),
    );
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it('remove : lève BadRequestException si le retour est COMPLETED', async () => {
    prisma.purchaseReturn.findUnique.mockResolvedValue({ organizationId: ORG_A, status: 'COMPLETED', deletedAt: null });

    await expect(service.remove(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('remove : soft-delete un retour PENDING', async () => {
    prisma.purchaseReturn.findUnique.mockResolvedValue({ organizationId: ORG_A, status: 'PENDING', deletedAt: null });
    prisma.purchaseReturn.update.mockResolvedValue({});

    await service.remove(PURCHASE_RETURN_ID, ORG_A);

    expect(prisma.purchaseReturn.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PURCHASE_RETURN_ID }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });

  // ─── send ────────────────────────────────────────────────────────────────

  it('send : enfile un job purchaseReturn.sendEmail sur la file email quand le fournisseur a un email', async () => {
    prisma.purchaseReturn.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      deletedAt: null,
      purchase: { provider: { email: 'fournisseur@example.com' } },
    });

    const result = await service.send(PURCHASE_RETURN_ID, ORG_A);

    expect(result).toEqual({ status: 'queued' });
    expect(emailQueue.add).toHaveBeenCalledWith('purchaseReturn.sendEmail', {
      organizationId: ORG_A,
      returnId: PURCHASE_RETURN_ID,
      to: 'fournisseur@example.com',
    });
  });

  it("send : lève BadRequestException si le fournisseur n'a pas d'adresse email", async () => {
    prisma.purchaseReturn.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      deletedAt: null,
      purchase: { provider: { email: null } },
    });

    await expect(service.send(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it('send : lève NotFoundException si le retour est introuvable ou soft-supprimé', async () => {
    prisma.purchaseReturn.findUnique.mockResolvedValue(null);

    await expect(service.send(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(NotFoundException);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it("send : lève ForbiddenException si le retour appartient à une autre organisation (anti-IDOR)", async () => {
    prisma.purchaseReturn.findUnique.mockResolvedValue({
      organizationId: ORG_B,
      deletedAt: null,
      purchase: { provider: { email: 'fournisseur@example.com' } },
    });

    await expect(service.send(PURCHASE_RETURN_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});
