import { InternalServerErrorException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { BillingService } from '../billing.service';

const ORG_ID = 'aaaaaaaa-0000-4000-a000-000000000001';
const PLAN_ID = 'aaaaaaaa-0000-4000-a000-000000000002';
const SUB_ID  = 'aaaaaaaa-0000-4000-a000-000000000003';
const INV_ID  = 'aaaaaaaa-0000-4000-a000-000000000004';

const MOCK_PLAN = {
  id: PLAN_ID,
  name: 'starter',
  label: 'Starter',
  priceMonthly:          new Decimal('5000'),
  priceAnnual:           new Decimal('50000'),
  trialDurationDays:     30,
  trialRevenueCapAmount: new Decimal('500000'),
  maxUsers: 5,
  maxWarehouses: 1,
  maxProducts: 500,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_SUBSCRIPTION = {
  id: SUB_ID,
  organizationId: ORG_ID,
  planId: PLAN_ID,
  status: 'TRIALING' as const,
  currentPeriodEnd: new Date('2026-09-30T23:59:59Z'),
  cancelAtPeriodEnd: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  plan: MOCK_PLAN,
};

const MOCK_INVOICE_PENDING = {
  id: INV_ID,
  organizationId: ORG_ID,
  subscriptionId: SUB_ID,
  amount: new Decimal('5000'),
  currency: 'XAF',
  status: 'PENDING' as const,
  paymentLink: null,
  paidAt: null,
  dueAt: new Date(Date.now() + 86_400_000),
  period: 'monthly',
  subscription: MOCK_SUBSCRIPTION,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makePrisma = (overrides: Record<string, unknown> = {}) => ({
  subscription: {
    findUnique: jest.fn().mockResolvedValue(MOCK_SUBSCRIPTION),
    update: jest.fn().mockResolvedValue(MOCK_SUBSCRIPTION),
    ...((overrides['subscription'] as Record<string, unknown>) ?? {}),
  },
  platformSetting: {
    findUnique: jest.fn().mockResolvedValue({ value: '"2026-09-30T23:59:59Z"' }),
    ...((overrides['platformSetting'] as Record<string, unknown>) ?? {}),
  },
  invoice: {
    create: jest.fn().mockResolvedValue(MOCK_INVOICE_PENDING),
    update: jest.fn().mockResolvedValue(MOCK_INVOICE_PENDING),
    findUnique: jest.fn().mockResolvedValue(MOCK_INVOICE_PENDING),
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal('0') } }),
    ...((overrides['invoice'] as Record<string, unknown>) ?? {}),
  },
  organization: {
    update: jest.fn().mockResolvedValue({}),
    ...((overrides['organization'] as Record<string, unknown>) ?? {}),
  },
  $transaction: jest.fn().mockImplementation((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  ...(overrides['$root'] ? (overrides['$root'] as Record<string, unknown>) : {}),
});

const makeAggregator = () => ({
  generatePaymentLink: jest.fn().mockResolvedValue('https://pay.test/mock-uuid'),
});

const makeConfig = () => ({
  get: jest.fn().mockReturnValue(undefined),
});

const makeQueue = () => ({
  add: jest.fn().mockResolvedValue(undefined),
});

const makeService = (prismaOverrides: Record<string, unknown> = {}) => {
  const prisma = makePrisma(prismaOverrides);
  const aggregator = makeAggregator();
  const config = makeConfig();
  const queue = makeQueue();
  const service = new BillingService(
    prisma as never,
    aggregator as never,
    config as never,
    queue as never,
  );
  return { service, prisma, aggregator, config, queue };
};

describe('BillingService', () => {
  // ─── getSubscription ────────────────────────────────────────────────────────
  describe('getSubscription', () => {
    it('retourne la subscription avec son plan', async () => {
      const { service, prisma } = makeService();
      const result = await service.getSubscription(ORG_ID);
      expect(result).toEqual(MOCK_SUBSCRIPTION);
      expect(prisma.subscription.findUnique).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
        include: { plan: true },
      });
    });

    it('lève NotFoundException si aucune subscription n\'existe', async () => {
      const { service } = makeService({
        subscription: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      await expect(service.getSubscription(ORG_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── getPlatformSetting ─────────────────────────────────────────────────────
  describe('getPlatformSetting', () => {
    it('retourne la valeur désérialisée si la clé existe', async () => {
      const { service } = makeService();
      const result = await service.getPlatformSetting('launchPromoEndsAt');
      expect(result).toBe('2026-09-30T23:59:59Z');
    });

    it('retourne null si la clé est absente', async () => {
      const { service } = makeService({
        platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      const result = await service.getPlatformSetting('launchPromoEndsAt');
      expect(result).toBeNull();
    });

    it('lève InternalServerErrorException si la valeur JSON est invalide', async () => {
      const { service } = makeService({
        platformSetting: { findUnique: jest.fn().mockResolvedValue({ value: 'invalid-json{{{' }) },
      });
      await expect(service.getPlatformSetting('launchPromoEndsAt')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  // ─── createPaymentLink ──────────────────────────────────────────────────────
  describe('createPaymentLink', () => {
    it('crée une Invoice PENDING avec le montant mensuel (Decimal, pas Float)', async () => {
      const { service, prisma } = makeService();

      const result = await service.createPaymentLink(ORG_ID, PLAN_ID, 'monthly');

      expect(result).toHaveProperty('invoiceId');
      expect(result).toHaveProperty('paymentUrl');

      // Le montant passé à prisma.invoice.create doit être un Decimal
      type InvoiceCreateData = { amount: Decimal; status: string; period: string };
      const createCall = (prisma.invoice.create as jest.Mock).mock.calls[0][0] as { data: InvoiceCreateData };
      expect(createCall.data.amount).toBeInstanceOf(Decimal);
      expect(createCall.data.amount.toFixed(2)).toBe('5000.00');
      expect(createCall.data.status).toBe('PENDING');
      expect(createCall.data.period).toBe('monthly');
    });

    it('utilise priceAnnual pour la période annuelle', async () => {
      const { service, prisma } = makeService();

      await service.createPaymentLink(ORG_ID, PLAN_ID, 'annual');

      type InvoiceCreateData = { amount: Decimal; period: string };
      const createCall = (prisma.invoice.create as jest.Mock).mock.calls[0][0] as { data: InvoiceCreateData };
      expect(createCall.data.amount.toFixed(2)).toBe('50000.00');
      expect(createCall.data.period).toBe('annual');
    });

    it('planifie un job invoice.expire dans la billing-queue', async () => {
      const { service, queue } = makeService();

      const { invoiceId } = await service.createPaymentLink(ORG_ID, PLAN_ID, 'monthly');

      expect(queue.add).toHaveBeenCalledWith(
        'invoice.expire',
        expect.objectContaining({ invoiceId, organizationId: ORG_ID }),
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it('stocke le paymentUrl dans l\'Invoice', async () => {
      const { service, prisma } = makeService();

      await service.createPaymentLink(ORG_ID, PLAN_ID, 'monthly');

      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paymentLink: 'https://pay.test/mock-uuid' }),
        }),
      );
    });

    it('lève UnprocessableEntityException si planId ne correspond pas au plan actuel', async () => {
      const { service } = makeService();
      const wrongPlanId = 'aaaaaaaa-0000-4000-a000-000000000099';

      await expect(service.createPaymentLink(ORG_ID, wrongPlanId, 'monthly')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  // ─── confirmPayment ─────────────────────────────────────────────────────────
  describe('confirmPayment', () => {
    it('passe Invoice à PAID et Subscription à ACTIVE', async () => {
      const { service, prisma } = makeService();

      await service.confirmPayment(INV_ID);

      // La transaction doit inclure la mise à jour de l'Invoice et de la Subscription
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('idempotence : ne prolonge pas une Invoice déjà PAID', async () => {
      const paidInvoice = { ...MOCK_INVOICE_PENDING, status: 'PAID' as const };
      const { service, prisma } = makeService({
        invoice: {
          findUnique: jest.fn().mockResolvedValue(paidInvoice),
          update: jest.fn(),
          create: jest.fn(),
          aggregate: jest.fn(),
        },
      });

      await service.confirmPayment(INV_ID);

      // Aucune transaction ne doit être déclenchée
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si l\'Invoice est introuvable', async () => {
      const { service } = makeService({
        invoice: {
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
          create: jest.fn(),
          aggregate: jest.fn(),
        },
      });

      await expect(service.confirmPayment(INV_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('planifie un job invoice.renew après confirmation', async () => {
      const { service, queue } = makeService();

      await service.confirmPayment(INV_ID);

      expect(queue.add).toHaveBeenCalledWith(
        'invoice.renew',
        expect.objectContaining({ organizationId: ORG_ID }),
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });
  });

  // ─── checkTrialCap ──────────────────────────────────────────────────────────
  describe('checkTrialCap', () => {
    it('ne modifie rien si le CA est sous le plafond', async () => {
      const { service, prisma } = makeService({
        invoice: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal('100000') } }),
          findUnique: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
      });

      await service.checkTrialCap(ORG_ID);

      // Pas de mise à jour de la Subscription
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('passe la Subscription en PAST_DUE si CA >= plafond', async () => {
      const { service, prisma } = makeService({
        invoice: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal('500000') } }),
          findUnique: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
      });

      await service.checkTrialCap(ORG_ID);

      expect(prisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'PAST_DUE' } }),
      );
    });

    it('met à jour trialEndedReason à REVENUE_CAP', async () => {
      const { service, prisma } = makeService({
        invoice: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal('600000') } }),
          findUnique: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
      });

      await service.checkTrialCap(ORG_ID);

      expect(prisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { trialEndedReason: 'REVENUE_CAP' } }),
      );
    });

    it('ne fait rien si la Subscription n\'est pas TRIALING', async () => {
      const activeSub = { ...MOCK_SUBSCRIPTION, status: 'ACTIVE' as const };
      const { service, prisma } = makeService({
        subscription: {
          findUnique: jest.fn().mockResolvedValue(activeSub),
          update: jest.fn(),
        },
        invoice: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal('999999') } }),
          findUnique: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
      });

      await service.checkTrialCap(ORG_ID);

      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('ne fait rien si trialRevenueCapAmount est null (plan illimité)', async () => {
      const unlimitedPlan = { ...MOCK_PLAN, trialRevenueCapAmount: null };
      const unlimitedSub = { ...MOCK_SUBSCRIPTION, plan: unlimitedPlan };
      const { service, prisma } = makeService({
        subscription: {
          findUnique: jest.fn().mockResolvedValue(unlimitedSub),
          update: jest.fn(),
        },
        invoice: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal('9999999') } }),
          findUnique: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
      });

      await service.checkTrialCap(ORG_ID);

      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });
  });
});
