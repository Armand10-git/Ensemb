import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { BillingService } from '../billing.service';

const ORG_ID = 'aaaaaaaa-0000-4000-a000-000000000001';
const PLAN_ID = 'aaaaaaaa-0000-4000-a000-000000000002';
const SUB_ID  = 'aaaaaaaa-0000-4000-a000-000000000003';

const MOCK_PLAN = {
  id: PLAN_ID,
  name: 'starter',
  label: 'Starter',
  priceMonthly: 5000,
  priceAnnual: 50000,
  trialDurationDays: 30,
  trialRevenueCapAmount: 500000,
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

const makePrisma = (overrides: Record<string, unknown> = {}) => ({
  subscription: {
    findUnique: jest.fn().mockResolvedValue(MOCK_SUBSCRIPTION),
    ...((overrides['subscription'] as Record<string, unknown>) ?? {}),
  },
  platformSetting: {
    findUnique: jest.fn().mockResolvedValue({ value: '"2026-09-30T23:59:59Z"' }),
    ...((overrides['platformSetting'] as Record<string, unknown>) ?? {}),
  },
});

describe('BillingService', () => {
  describe('getSubscription', () => {
    it('retourne la subscription avec son plan', async () => {
      const prisma = makePrisma();
      const service = new BillingService(prisma as never);

      const result = await service.getSubscription(ORG_ID);

      expect(result).toEqual(MOCK_SUBSCRIPTION);
      expect(prisma.subscription.findUnique).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
        include: { plan: true },
      });
    });

    it('lève NotFoundException si aucune subscription n\'existe', async () => {
      const prisma = makePrisma({
        subscription: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      const service = new BillingService(prisma as never);

      await expect(service.getSubscription(ORG_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getPlatformSetting', () => {
    it('retourne la valeur désérialisée si la clé existe', async () => {
      const prisma = makePrisma();
      const service = new BillingService(prisma as never);

      const result = await service.getPlatformSetting('launchPromoEndsAt');

      expect(result).toBe('2026-09-30T23:59:59Z');
    });

    it('retourne null si la clé est absente', async () => {
      const prisma = makePrisma({
        platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      const service = new BillingService(prisma as never);

      const result = await service.getPlatformSetting('launchPromoEndsAt');

      expect(result).toBeNull();
    });

    it('lève InternalServerErrorException si la valeur JSON est invalide', async () => {
      const prisma = makePrisma({
        platformSetting: { findUnique: jest.fn().mockResolvedValue({ value: 'invalid-json{{{' }) },
      });
      const service = new BillingService(prisma as never);

      await expect(service.getPlatformSetting('launchPromoEndsAt')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });
});
