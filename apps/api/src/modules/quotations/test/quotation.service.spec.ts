import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Decimal } from '@prisma/client/runtime/library';
import { QuotationService } from '../quotation.service';
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
const QUOTE_ID  = 'quot0001-0000-0000-0000-000000000001';
const REF       = 'DEV-2026-000001';
const SALE_REF  = 'VTE-2026-000042';

function makeQuotation(overrides: Partial<{
  id: string;
  organizationId: string;
  userId: string;
  status: 'PENDING' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'CANCELLED';
  deletedAt: Date | null;
  taxRate: Decimal;
  discount: Decimal;
  shipping: Decimal;
  details: unknown[];
  client: { id: string; name: string; email: string | null; phone: string | null };
}> = {}) {
  return {
    id: QUOTE_ID,
    organizationId: ORG_A,
    reference: REF,
    date: new Date('2026-07-26'),
    userId: USER_ID,
    clientId: CLIENT_ID,
    warehouseId: WH_ID,
    taxRate: new Decimal('0'),
    taxAmount: new Decimal('0'),
    discount: new Decimal('0'),
    shipping: new Decimal('0'),
    grandTotal: new Decimal('15000'),
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
        quoteUnitId: null,
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

describe('QuotationService', () => {
  let service: QuotationService;

  let prisma: {
    client: { findUnique: jest.Mock };
    warehouse: { findUnique: jest.Mock };
    product: { findMany: jest.Mock };
    productVariant: { findMany: jest.Mock };
    unit: { findMany: jest.Mock };
    quotation: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    quotationDetail: { deleteMany: jest.Mock; createMany: jest.Mock };
    sale: { create: jest.Mock };
    $transaction: jest.Mock;
  };

  let documentCounter: { nextReference: jest.Mock };
  let emailQueue: { add: jest.Mock };
  let smsQueue: { add: jest.Mock };
  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      client: { findUnique: jest.fn() },
      warehouse: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      productVariant: { findMany: jest.fn() },
      unit: { findMany: jest.fn() },
      quotation: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      quotationDetail: { deleteMany: jest.fn(), createMany: jest.fn() },
      sale: { create: jest.fn() },
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
    const emailQueueMock = { add: jest.fn().mockResolvedValue(undefined) };
    const smsQueueMock   = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        QuotationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: DocumentCounterService, useValue: dcMock },
        { provide: RealtimeGateway, useValue: rtMock },
        { provide: getQueueToken('email'), useValue: emailQueueMock },
        { provide: getQueueToken('sms'), useValue: smsQueueMock },
      ],
    }).compile();

    service = module.get(QuotationService);
    prisma = prismaMock;
    documentCounter = dcMock;
    emailQueue = emailQueueMock;
    smsQueue = smsQueueMock;
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

  it('create : crée un devis PENDING avec référence DEV-… et grandTotal calculé (Decimal)', async () => {
    mockOwnershipOk();
    prisma.quotation.create.mockResolvedValue(makeQuotation());

    const result = await service.create(ORG_A, USER_ID, baseDto());

    expect(documentCounter.nextReference).toHaveBeenCalledTimes(1);
    expect(prisma.quotation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          reference: REF,
        }),
      }),
    );
    // subTotal = 15000 × 1 = 15000, pas de taxe/remise → grandTotal = 15000
    const createArgs = prisma.quotation.create.mock.calls[0][0] as {
      data: { grandTotal: Decimal };
    };
    expect(createArgs.data.grandTotal.toString()).toBe('15000');
    expect(result.reference).toBe(REF);
    expect(toEmit).toHaveBeenCalledWith(
      'quotation:created',
      expect.objectContaining({ quotationId: QUOTE_ID }),
    );
  });

  it('create : discount global déduit du grandTotal', async () => {
    mockOwnershipOk();
    prisma.quotation.create.mockResolvedValue(makeQuotation());

    await service.create(
      ORG_A,
      USER_ID,
      baseDto({
        details: [{ productId: PROD_ID, price: '10000', quantity: '1' }],
        discount: '1500',
        shipping: '500',
      }),
    );

    const createArgs = prisma.quotation.create.mock.calls[0][0] as {
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
    prisma.quotation.findMany.mockResolvedValue([]);
    prisma.quotation.count.mockResolvedValue(0);

    await service.findAll(ORG_A, OTHER_USER, false, 1, 20);

    expect(prisma.quotation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_A, userId: OTHER_USER }),
      }),
    );
  });

  it('findAll : viewAll=true ne filtre pas par userId', async () => {
    prisma.quotation.findMany.mockResolvedValue([]);
    prisma.quotation.count.mockResolvedValue(0);

    await service.findAll(ORG_A, OTHER_USER, true, 1, 20);

    const call = prisma.quotation.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty('userId');
  });

  // ─── send ────────────────────────────────────────────────────────────────

  describe('send', () => {
    it("channel=email, client avec email → enfile 'quotation.sendEmail' sur la file email", async () => {
      prisma.quotation.findUnique.mockResolvedValue(
        makeQuotation({ client: { id: CLIENT_ID, name: 'Client A', email: 'client@example.cm', phone: null } }),
      );

      const result = await service.send(QUOTE_ID, ORG_A, 'email');

      expect(emailQueue.add).toHaveBeenCalledWith('quotation.sendEmail', {
        organizationId: ORG_A,
        quotationId: QUOTE_ID,
        to: 'client@example.cm',
      });
      expect(smsQueue.add).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'queued' });
    });

    it("channel=sms, client avec téléphone → enfile 'quotation.sendSms' sur la file sms", async () => {
      prisma.quotation.findUnique.mockResolvedValue(
        makeQuotation({ client: { id: CLIENT_ID, name: 'Client A', email: null, phone: '+237600000000' } }),
      );

      const result = await service.send(QUOTE_ID, ORG_A, 'sms');

      expect(smsQueue.add).toHaveBeenCalledWith('quotation.sendSms', {
        organizationId: ORG_A,
        quotationId: QUOTE_ID,
        to: '+237600000000',
      });
      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'queued' });
    });

    it("channel=email, client sans email → BadRequestException, rien enfilé", async () => {
      prisma.quotation.findUnique.mockResolvedValue(
        makeQuotation({ client: { id: CLIENT_ID, name: 'Client A', email: null, phone: '+237600000000' } }),
      );

      await expect(service.send(QUOTE_ID, ORG_A, 'email')).rejects.toThrow(
        new BadRequestException("Ce client n'a pas d'adresse email enregistrée."),
      );
      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(smsQueue.add).not.toHaveBeenCalled();
    });

    it("vente d'une autre organisation → ForbiddenException, rien enfilé", async () => {
      prisma.quotation.findUnique.mockResolvedValue(
        makeQuotation({
          organizationId: ORG_B,
          client: { id: CLIENT_ID, name: 'Client A', email: 'client@example.cm', phone: '+237600000000' },
        }),
      );

      await expect(service.send(QUOTE_ID, ORG_A, 'email')).rejects.toThrow(ForbiddenException);
      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(smsQueue.add).not.toHaveBeenCalled();
    });

    it('devis introuvable → NotFoundException, rien enfilé', async () => {
      prisma.quotation.findUnique.mockResolvedValue(null);

      await expect(service.send(QUOTE_ID, ORG_A, 'email')).rejects.toThrow(NotFoundException);
      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(smsQueue.add).not.toHaveBeenCalled();
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────

  it('update : lève BadRequestException si le devis est COMPLETED', async () => {
    prisma.quotation.findUnique.mockResolvedValue(makeQuotation({ status: 'COMPLETED' }));

    await expect(
      service.update(QUOTE_ID, ORG_A, { notes: 'x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('update : lève NotFoundException si le devis est introuvable', async () => {
    prisma.quotation.findUnique.mockResolvedValue(null);

    await expect(service.update(QUOTE_ID, ORG_A, { notes: 'x' })).rejects.toThrow(NotFoundException);
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it('remove : lève BadRequestException si le devis est COMPLETED', async () => {
    prisma.quotation.findUnique.mockResolvedValue(makeQuotation({ status: 'COMPLETED' }));

    await expect(service.remove(QUOTE_ID, ORG_A)).rejects.toThrow(BadRequestException);
  });

  it('remove : soft-delete un devis PENDING', async () => {
    prisma.quotation.findUnique.mockResolvedValue(makeQuotation({ status: 'PENDING' }));
    prisma.quotation.update.mockResolvedValue({});

    await service.remove(QUOTE_ID, ORG_A);

    expect(prisma.quotation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: QUOTE_ID },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  // ─── convert (S28) ───────────────────────────────────────────────────────

  describe('convert', () => {
    it('crée une Sale PENDING/UNPAID avec les mêmes lignes, copie quoteUnitId → saleUnitId', async () => {
      const UNIT_CARTON = 'unit0002-0000-0000-0000-000000000002';
      prisma.quotation.findUnique.mockResolvedValue(
        makeQuotation({
          details: [
            {
              id: 'det1',
              productId: PROD_ID,
              productVariantId: null,
              quoteUnitId: UNIT_CARTON,
              price: new Decimal('15000'),
              taxAmount: new Decimal('0'),
              taxMethod: 'percentage',
              discount: new Decimal('0'),
              discountMethod: 'percentage',
              quantity: new Decimal('2'),
              total: new Decimal('30000'),
            },
          ],
        }),
      );
      documentCounter.nextReference.mockResolvedValue(SALE_REF);
      prisma.sale.create.mockResolvedValue({
        id: 'sale0099-0000-0000-0000-000000000099',
        organizationId: ORG_A,
        reference: SALE_REF,
        date: new Date(),
        isPos: false,
        userId: USER_ID,
        clientId: CLIENT_ID,
        warehouseId: WH_ID,
        taxRate: new Decimal('0'),
        taxAmount: new Decimal('0'),
        discount: new Decimal('0'),
        shipping: new Decimal('0'),
        grandTotal: new Decimal('30000'),
        paidAmount: new Decimal('0'),
        paymentStatus: 'UNPAID',
        status: 'PENDING',
        notes: null,
        cancelReason: null,
        cancelledAt: null,
        cancelledById: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        client: { id: CLIENT_ID, name: 'Client A' },
        warehouse: { id: WH_ID, name: 'Entrepôt A' },
        details: [],
      });
      prisma.quotation.update.mockResolvedValue({});

      const result = await service.convert(QUOTE_ID, ORG_A, USER_ID);

      expect(documentCounter.nextReference).toHaveBeenCalledWith(
        expect.anything(),
        ORG_A,
        'SALE',
      );
      expect(prisma.sale.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: ORG_A,
            userId: USER_ID,
            clientId: CLIENT_ID,
            warehouseId: WH_ID,
            status: 'PENDING',
            paymentStatus: 'UNPAID',
            isPos: false,
            quotationId: QUOTE_ID,
            details: {
              create: [
                expect.objectContaining({
                  productId: PROD_ID,
                  saleUnitId: UNIT_CARTON,
                  quantity: expect.any(Decimal),
                }),
              ],
            },
          }),
        }),
      );
      const createArgs = prisma.sale.create.mock.calls[0][0] as {
        data: { paidAmount: Decimal };
      };
      expect(createArgs.data.paidAmount.toString()).toBe('0');
      expect(prisma.quotation.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: QUOTE_ID }, data: { status: 'COMPLETED' } }),
      );
      expect(toEmit).toHaveBeenCalledWith(
        'sale:created',
        expect.objectContaining({ organizationId: ORG_A }),
      );
      expect(result.reference).toBe(SALE_REF);
    });

    it('devis déjà COMPLETED → BadRequestException, aucune Sale créée', async () => {
      prisma.quotation.findUnique.mockResolvedValue(makeQuotation({ status: 'COMPLETED' }));

      await expect(service.convert(QUOTE_ID, ORG_A, USER_ID)).rejects.toThrow(BadRequestException);
      expect(prisma.sale.create).not.toHaveBeenCalled();
      expect(prisma.quotation.update).not.toHaveBeenCalled();
    });

    it('devis déjà CANCELLED → BadRequestException, aucune Sale créée', async () => {
      prisma.quotation.findUnique.mockResolvedValue(makeQuotation({ status: 'CANCELLED' }));

      await expect(service.convert(QUOTE_ID, ORG_A, USER_ID)).rejects.toThrow(BadRequestException);
      expect(prisma.sale.create).not.toHaveBeenCalled();
    });

    it('devis introuvable → NotFoundException', async () => {
      prisma.quotation.findUnique.mockResolvedValue(null);

      await expect(service.convert(QUOTE_ID, ORG_A, USER_ID)).rejects.toThrow(NotFoundException);
      expect(prisma.sale.create).not.toHaveBeenCalled();
    });

    it("devis d'une autre organisation → ForbiddenException", async () => {
      prisma.quotation.findUnique.mockResolvedValue(makeQuotation({ organizationId: ORG_B }));

      await expect(service.convert(QUOTE_ID, ORG_A, USER_ID)).rejects.toThrow(ForbiddenException);
      expect(prisma.sale.create).not.toHaveBeenCalled();
    });
  });
});
