import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Decimal } from '@prisma/client/runtime/library';
import { SaleReturnService } from '../sale-return.service';
import { PrismaService } from '../../../common/prisma.service';
import { DocumentCounterService } from '../../../common/document-counter.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ProductWarehouseService, OptimisticLockException } from '../../inventory/product-warehouse.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A        = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B        = 'bbbb0000-0000-0000-0000-000000000002';
const USER_ID      = 'user0000-0000-0000-0000-000000000001';
const WH_ID        = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID      = 'prod0000-0000-0000-0000-000000000001';
const SALE_ID      = 'sale0001-0000-0000-0000-000000000001';
const OTHER_SALE_ID = 'sale0002-0000-0000-0000-000000000002';
const SALE_DETAIL_ID = 'sdet0001-0000-0000-0000-000000000001';
const SALE_RETURN_ID = 'sret0001-0000-0000-0000-000000000001';
const PW_ID        = 'pw000001-0000-0000-0000-000000000001';
const UNIT_PIECE   = 'unit0001-0000-0000-0000-000000000001';
const UNIT_CARTON  = 'unit0002-0000-0000-0000-000000000002';
const REF          = 'RVT-2026-000001';

function makeSaleReturn(overrides: Record<string, unknown> = {}) {
  return {
    id: SALE_RETURN_ID,
    organizationId: ORG_A,
    reference: REF,
    date: new Date('2026-07-26'),
    userId: USER_ID,
    saleId: SALE_ID,
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

describe('SaleReturnService', () => {
  let service: SaleReturnService;

  let prisma: {
    sale: { findUnique: jest.Mock };
    saleDetail: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    unit: { findMany: jest.Mock };
    productWarehouse: { findFirst: jest.Mock; create: jest.Mock };
    saleReturn: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    saleReturnDetail: { findMany: jest.Mock; deleteMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };
  let productWarehouseService: { adjustStock: jest.Mock };
  let emailQueue: { add: jest.Mock };
  let smsQueue: { add: jest.Mock };
  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      sale: { findUnique: jest.fn() },
      saleDetail: { findMany: jest.fn() },
      product: { findMany: jest.fn() },
      unit: { findMany: jest.fn() },
      productWarehouse: { findFirst: jest.fn(), create: jest.fn() },
      saleReturn: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      saleReturnDetail: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
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
    const pdfQueueMock = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        SaleReturnService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
        { provide: RealtimeGateway, useValue: rtMock },
        { provide: ProductWarehouseService, useValue: pwMock },
        { provide: getQueueToken('email'), useValue: emailQueueMock },
        { provide: getQueueToken('sms'), useValue: smsQueueMock },
        { provide: getQueueToken('pdf'), useValue: pdfQueueMock },
      ],
    }).compile();

    service = module.get(SaleReturnService);
    prisma = prismaMock;
    documentCounter = dcMock;
    productWarehouseService = pwMock;
    smsQueue = smsQueueMock;
    emailQueue = emailQueueMock;
  });

  afterEach(() => jest.clearAllMocks());

  function baseDto(overrides: Record<string, unknown> = {}) {
    return {
      saleId: SALE_ID,
      date: '2026-07-26T00:00:00.000Z',
      details: [{ saleDetailId: SALE_DETAIL_ID, quantity: '3' }],
      ...overrides,
    };
  }

  function mockSaleOk(status = 'COMPLETED') {
    prisma.sale.findUnique.mockResolvedValue({
      id: SALE_ID,
      organizationId: ORG_A,
      deletedAt: null,
      status,
      warehouseId: WH_ID,
    });
  }

  function mockSaleDetailSource(overrides: Record<string, unknown> = {}) {
    prisma.saleDetail.findMany.mockResolvedValue([
      {
        id: SALE_DETAIL_ID,
        saleId: SALE_ID,
        productId: PROD_ID,
        productVariantId: null,
        saleUnitId: null,
        price: new Decimal('1500'),
        taxAmount: new Decimal('0'),
        taxMethod: 'percentage',
        discount: new Decimal('0'),
        discountMethod: 'percentage',
        quantity: new Decimal('10'),
        ...overrides,
      },
    ]);
  }

  // ─── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('copie price/taxAmount/taxMethod/discount/discountMethod depuis la SaleDetail source (jamais du DTO)', async () => {
      mockSaleOk();
      mockSaleDetailSource({
        price: new Decimal('1500'),
        taxAmount: new Decimal('100'),
        taxMethod: 'fixed',
        discount: new Decimal('50'),
        discountMethod: 'fixed',
        quantity: new Decimal('10'),
      });
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.saleReturn.create.mockResolvedValue(makeSaleReturn());

      await service.create(ORG_A, USER_ID, baseDto({ details: [{ saleDetailId: SALE_DETAIL_ID, quantity: '3' }] }));

      const createArgs = prisma.saleReturn.create.mock.calls[0][0] as {
        data: { details: { create: { price: Decimal; taxAmount: Decimal; taxMethod: string; discount: Decimal; discountMethod: string; total: Decimal }[] } };
      };
      const line = createArgs.data.details.create[0]!;
      expect(line.price.toString()).toBe('1500');
      expect(line.taxAmount.toString()).toBe('100');
      expect(line.taxMethod).toBe('fixed');
      expect(line.discount.toString()).toBe('50');
      expect(line.discountMethod).toBe('fixed');
      // subTotal = 1500 × 3 = 4500, taxe fixe 100, remise fixe 50 → 4550
      expect(line.total.toString()).toBe('4550');
    });

    it("lève ForbiddenException si saleDetailId n'appartient pas au saleId déclaré (IDOR)", async () => {
      mockSaleOk();
      mockSaleDetailSource({ saleId: OTHER_SALE_ID });
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);

      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
      expect(prisma.saleReturn.create).not.toHaveBeenCalled();
    });

    it("lève BadRequestException si la vente d'origine n'est pas COMPLETED", async () => {
      mockSaleOk('PENDING');

      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(BadRequestException);
      expect(prisma.saleReturn.create).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si la vente appartient à une autre organisation", async () => {
      prisma.sale.findUnique.mockResolvedValue({
        id: SALE_ID,
        organizationId: ORG_B,
        deletedAt: null,
        status: 'COMPLETED',
        warehouseId: WH_ID,
      });

      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si la vente est introuvable', async () => {
      prisma.sale.findUnique.mockResolvedValue(null);

      await expect(service.create(ORG_A, USER_ID, baseDto())).rejects.toThrow(NotFoundException);
    });

    it('lève BadRequestException (best-effort) si la quantité retournée dépasse la quantité vendue sur cette ligne', async () => {
      mockSaleOk();
      mockSaleDetailSource({ quantity: new Decimal('5') });
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);

      await expect(
        service.create(ORG_A, USER_ID, baseDto({ details: [{ saleDetailId: SALE_DETAIL_ID, quantity: '6' }] })),
      ).rejects.toThrow(BadRequestException);
    });

    it('crée un retour PENDING avec référence RVT-… et warehouseId copié depuis la vente', async () => {
      mockSaleOk();
      mockSaleDetailSource();
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.saleReturn.create.mockResolvedValue(makeSaleReturn());

      const result = await service.create(ORG_A, USER_ID, baseDto());

      expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
      expect(prisma.saleReturn.create).toHaveBeenCalledWith(
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
      return makeSaleReturn({ status, details });
    }

    function mockValidateHappyPath(opts: { newQuantity: string }) {
      prisma.productWarehouse.findFirst.mockResolvedValue({ id: PW_ID, version: 0 });
      productWarehouseService.adjustStock.mockResolvedValue({
        id: PW_ID,
        productId: PROD_ID,
        productVariantId: null,
        warehouseId: WH_ID,
        quantity: new Decimal(opts.newQuantity),
        version: 1,
      });
      prisma.saleReturn.update.mockResolvedValue({});
      prisma.saleReturn.findUniqueOrThrow.mockResolvedValue(makeSaleReturn({ status: 'COMPLETED' }));
    }

    it('rejette un retour non-PENDING (déjà COMPLETED)', async () => {
      prisma.saleReturn.findUnique.mockResolvedValue(makeValidateReturn([], 'COMPLETED'));

      await expect(service.validate(SALE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it("lève ForbiddenException si le retour appartient à une autre organisation", async () => {
      prisma.saleReturn.findUnique.mockResolvedValue(makeSaleReturn({ organizationId: ORG_B, status: 'PENDING' }));

      await expect(service.validate(SALE_RETURN_ID, ORG_A)).rejects.toThrow(ForbiddenException);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });

    it('incrémente le stock (sens INCREMENT, mirror PurchaseService) sur une ligne simple', async () => {
      prisma.saleReturn.findUnique.mockResolvedValue(
        makeValidateReturn([
          { saleDetailId: SALE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('3') },
        ]),
      );
      prisma.saleDetail.findMany.mockResolvedValue([
        { id: SALE_DETAIL_ID, productId: PROD_ID, saleUnitId: null, quantity: new Decimal('10') },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.saleReturnDetail.findMany.mockResolvedValue([]); // aucun retour COMPLETED existant
      prisma.unit.findMany.mockResolvedValue([]);
      mockValidateHappyPath({ newQuantity: '3' });

      const result = await service.validate(SALE_RETURN_ID, ORG_A);

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      const [, , , delta] = productWarehouseService.adjustStock.mock.calls[0] as [unknown, unknown, unknown, Decimal];
      // Retour de vente → incrément (delta positif), contrairement à SaleService.validate() (décrément).
      expect(delta.toString()).toBe('3');
      expect(prisma.saleReturn.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SALE_RETURN_ID }, data: { status: 'COMPLETED' } }),
      );
      expect(result.status).toBe('COMPLETED');
    });

    it(
      'plafond cumulé AVEC conversion d\'unité — SaleDetail vendue en carton (1 carton = 12 pièces), ' +
        'retour exprimé en pièces : la comparaison se fait bien en unité de BASE (piège de conception)',
      async () => {
        // Vendu : 1 carton = 12 pièces (base). Retour demandé : 10 pièces (déjà en base).
        // Une comparaison naïve "1 (carton) vs 10 (pièces)" rejetterait à tort (10 > 1) ;
        // la comparaison correcte en base (12 vs 10) doit accepter.
        prisma.saleReturn.findUnique.mockResolvedValue(
          makeValidateReturn([
            { saleDetailId: SALE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('10') },
          ]),
        );
        prisma.saleDetail.findMany.mockResolvedValue([
          { id: SALE_DETAIL_ID, productId: PROD_ID, saleUnitId: UNIT_CARTON, quantity: new Decimal('1') },
        ]);
        prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
        prisma.saleReturnDetail.findMany.mockResolvedValue([]);
        prisma.unit.findMany.mockResolvedValue([
          { id: UNIT_CARTON, operator: '*', operatorValue: new Decimal('12') },
        ]);
        mockValidateHappyPath({ newQuantity: '10' });

        await expect(service.validate(SALE_RETURN_ID, ORG_A)).resolves.toBeDefined();
        expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'plafond cumulé AVEC conversion d\'unité — dépassement détecté correctement en base ' +
        '(12 pièces vendues, 13 pièces demandées au total → rejeté)',
      async () => {
        prisma.saleReturn.findUnique.mockResolvedValue(
          makeValidateReturn([
            { saleDetailId: SALE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('13') },
          ]),
        );
        prisma.saleDetail.findMany.mockResolvedValue([
          { id: SALE_DETAIL_ID, productId: PROD_ID, saleUnitId: UNIT_CARTON, quantity: new Decimal('1') },
        ]);
        prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
        prisma.saleReturnDetail.findMany.mockResolvedValue([]);
        prisma.unit.findMany.mockResolvedValue([
          { id: UNIT_CARTON, operator: '*', operatorValue: new Decimal('12') },
        ]);

        await expect(service.validate(SALE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
        expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
      },
    );

    it(
      'plafond cumulé — un retour COMPLETED existant (converti en base) + cette ligne dépasse la ' +
        'quantité vendue à l\'origine → BadRequestException',
      async () => {
        // Vendu : 1 carton = 12 pièces. Retour COMPLETED précédent : 1 carton (12 pièces base).
        // Cette ligne : 1 pièce supplémentaire → 12 + 1 = 13 > 12 → doit être rejeté.
        prisma.saleReturn.findUnique.mockResolvedValue(
          makeValidateReturn([
            { saleDetailId: SALE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('1') },
          ]),
        );
        prisma.saleDetail.findMany.mockResolvedValue([
          { id: SALE_DETAIL_ID, productId: PROD_ID, saleUnitId: UNIT_CARTON, quantity: new Decimal('1') },
        ]);
        prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
        prisma.saleReturnDetail.findMany.mockResolvedValue([
          { saleDetailId: SALE_DETAIL_ID, quantity: new Decimal('1'), returnUnitId: UNIT_CARTON },
        ]);
        prisma.unit.findMany.mockResolvedValue([
          { id: UNIT_CARTON, operator: '*', operatorValue: new Decimal('12') },
        ]);

        await expect(service.validate(SALE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
        expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
      },
    );

    // ─── retry sur conflit de concurrence (mirror PurchaseService) ─────────

    it('retry : OptimisticLockException une seule fois puis succès → COMPLETED sans exception propagée', async () => {
      prisma.saleReturn.findUnique.mockResolvedValue(
        makeValidateReturn([
          { saleDetailId: SALE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('3') },
        ]),
      );
      prisma.saleDetail.findMany.mockResolvedValue([
        { id: SALE_DETAIL_ID, productId: PROD_ID, saleUnitId: null, quantity: new Decimal('10') },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.saleReturnDetail.findMany.mockResolvedValue([]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({ id: PW_ID, version: 0 });
      productWarehouseService.adjustStock
        .mockRejectedValueOnce(new OptimisticLockException(PW_ID, 0, 1))
        .mockResolvedValueOnce({
          id: PW_ID,
          productId: PROD_ID,
          productVariantId: null,
          warehouseId: WH_ID,
          quantity: new Decimal('3'),
          version: 1,
        });
      prisma.saleReturn.update.mockResolvedValue({});
      prisma.saleReturn.findUniqueOrThrow.mockResolvedValue(makeSaleReturn({ status: 'COMPLETED' }));

      const result = await service.validate(SALE_RETURN_ID, ORG_A);

      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('COMPLETED');
    });

    it('retry : conflit persistant sur les 5 tentatives → ConflictException finale', async () => {
      prisma.saleReturn.findUnique.mockResolvedValue(
        makeValidateReturn([
          { saleDetailId: SALE_DETAIL_ID, productId: PROD_ID, productVariantId: null, returnUnitId: null, quantity: new Decimal('1') },
        ]),
      );
      prisma.saleDetail.findMany.mockResolvedValue([
        { id: SALE_DETAIL_ID, productId: PROD_ID, saleUnitId: null, quantity: new Decimal('10') },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: PROD_ID, unitId: UNIT_PIECE }]);
      prisma.saleReturnDetail.findMany.mockResolvedValue([]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.productWarehouse.findFirst.mockResolvedValue({ id: PW_ID, version: 0 });
      productWarehouseService.adjustStock.mockRejectedValue(new OptimisticLockException(PW_ID, 0, 1));

      await expect(service.validate(SALE_RETURN_ID, ORG_A)).rejects.toThrow(ConflictException);
      expect(productWarehouseService.adjustStock).toHaveBeenCalledTimes(5);
      expect(prisma.saleReturn.update).not.toHaveBeenCalled();
    });

    it("retry : une BadRequestException n'est jamais retentée (relancée à la 1re tentative)", async () => {
      prisma.saleReturn.findUnique.mockResolvedValue(makeValidateReturn([], 'COMPLETED'));

      await expect(service.validate(SALE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
      expect(prisma.saleReturn.findUnique).toHaveBeenCalledTimes(1);
      expect(productWarehouseService.adjustStock).not.toHaveBeenCalled();
    });
  });

  // ─── findAll ─────────────────────────────────────────────────────────────

  it('findAll : viewAll=false injecte un filtre userId', async () => {
    prisma.saleReturn.findMany.mockResolvedValue([]);
    prisma.saleReturn.count.mockResolvedValue(0);

    await service.findAll(ORG_A, USER_ID, false, 1, 20);

    expect(prisma.saleReturn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_A, userId: USER_ID }) }),
    );
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it('remove : lève BadRequestException si le retour est COMPLETED', async () => {
    prisma.saleReturn.findUnique.mockResolvedValue({ organizationId: ORG_A, status: 'COMPLETED', deletedAt: null });

    await expect(service.remove(SALE_RETURN_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('remove : soft-delete un retour PENDING', async () => {
    prisma.saleReturn.findUnique.mockResolvedValue({ organizationId: ORG_A, status: 'PENDING', deletedAt: null });
    prisma.saleReturn.update.mockResolvedValue({});

    await service.remove(SALE_RETURN_ID, ORG_A);

    expect(prisma.saleReturn.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SALE_RETURN_ID }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });

  // ─── send ────────────────────────────────────────────────────────────────

  it('send : enfile un job saleReturn.sendEmail sur la file email quand le client a un email', async () => {
    prisma.saleReturn.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      deletedAt: null,
      sale: { client: { email: 'client@example.com' } },
    });

    const result = await service.send(SALE_RETURN_ID, ORG_A, 'email');

    expect(result).toEqual({ status: 'queued' });
    expect(emailQueue.add).toHaveBeenCalledWith('saleReturn.sendEmail', {
      organizationId: ORG_A,
      returnId: SALE_RETURN_ID,
      to: 'client@example.com',
    });
  });

  it("send : lève BadRequestException si le client n'a pas d'adresse email", async () => {
    prisma.saleReturn.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      deletedAt: null,
      sale: { client: { email: null } },
    });

    await expect(service.send(SALE_RETURN_ID, ORG_A, 'email')).rejects.toThrow(BadRequestException);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it('send : enfile un job saleReturn.sendSms sur la file sms quand le client a un téléphone', async () => {
    prisma.saleReturn.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      deletedAt: null,
      sale: { client: { phone: '+237600000000' } },
    });

    const result = await service.send(SALE_RETURN_ID, ORG_A, 'sms');

    expect(result).toEqual({ status: 'queued' });
    expect(smsQueue.add).toHaveBeenCalledWith('saleReturn.sendSms', {
      organizationId: ORG_A,
      returnId: SALE_RETURN_ID,
      to: '+237600000000',
    });
  });

  it("send : lève BadRequestException si le client n'a pas de numéro de téléphone", async () => {
    prisma.saleReturn.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      deletedAt: null,
      sale: { client: { phone: null } },
    });

    await expect(service.send(SALE_RETURN_ID, ORG_A, 'sms')).rejects.toThrow(BadRequestException);
    expect(smsQueue.add).not.toHaveBeenCalled();
  });

  it('send : lève NotFoundException si le retour est introuvable ou soft-supprimé', async () => {
    prisma.saleReturn.findUnique.mockResolvedValue(null);

    await expect(service.send(SALE_RETURN_ID, ORG_A, 'email')).rejects.toThrow(NotFoundException);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it("send : lève ForbiddenException si le retour appartient à une autre organisation (anti-IDOR)", async () => {
    prisma.saleReturn.findUnique.mockResolvedValue({
      organizationId: ORG_B,
      deletedAt: null,
      sale: { client: { email: 'client@example.com' } },
    });

    await expect(service.send(SALE_RETURN_ID, ORG_A, 'email')).rejects.toThrow(ForbiddenException);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});
