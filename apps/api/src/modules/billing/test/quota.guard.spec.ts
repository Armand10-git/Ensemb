import { ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { QuotaGuard } from '../quota.guard';
import { QUOTA_RESOURCE_KEY } from '../check-quota.decorator';

const ORG_ID = 'aaaaaaaa-0000-4000-a000-000000000001';

const makeContext = (organizationId: string = ORG_ID) => ({
  switchToHttp: () => ({
    getRequest: () => ({ user: { id: 'user-1', organizationId, email: 'a@b.com', isActive: true } }),
  }),
  getHandler: () => ({}),
  getClass: () => ({}),
});

const makeReflector = (resource: string | undefined) => ({
  getAllAndOverride: jest.fn().mockReturnValue(resource),
}) as unknown as Reflector;

const makeSubscription = (maxUsers: number | null) => ({
  id: 'sub-1',
  organizationId: ORG_ID,
  planId: 'plan-1',
  status: 'TRIALING',
  currentPeriodEnd: new Date(),
  cancelAtPeriodEnd: false,
  plan: {
    id: 'plan-1',
    name: 'starter',
    label: 'Starter',
    maxUsers,
    maxWarehouses: 1,
    maxProducts: 500,
  },
});

const makeBillingService = (maxUsers: number | null) => ({
  getSubscription: jest.fn().mockResolvedValue(makeSubscription(maxUsers)),
});

const makePrisma = (userCount: number) => ({
  user: {
    count: jest.fn().mockResolvedValue(userCount),
  },
});

describe('QuotaGuard', () => {
  describe('canActivate', () => {
    it('laisse passer si count < maxUsers', async () => {
      const guard = new QuotaGuard(
        makeReflector('users'),
        makeBillingService(5) as never,
        makePrisma(3) as never,
      );
      const context = makeContext();

      const result = await guard.canActivate(context as never);

      expect(result).toBe(true);
    });

    it('laisse passer si maxUsers est null (plan illimité)', async () => {
      const guard = new QuotaGuard(
        makeReflector('users'),
        makeBillingService(null) as never,
        makePrisma(1000) as never,
      );
      const context = makeContext();

      const result = await guard.canActivate(context as never);

      expect(result).toBe(true);
    });

    it('lève ForbiddenException si count >= maxUsers', async () => {
      const guard = new QuotaGuard(
        makeReflector('users'),
        makeBillingService(5) as never,
        makePrisma(5) as never,
      );
      const context = makeContext();

      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('le message 403 contient le nom du plan et la limite', async () => {
      const guard = new QuotaGuard(
        makeReflector('users'),
        makeBillingService(5) as never,
        makePrisma(5) as never,
      );
      const context = makeContext();

      const err = await guard.canActivate(context as never).catch((e: unknown) => e);
      const msg = (err as ForbiddenException).message;

      expect(msg).toContain('5');
      expect(msg).toContain('Starter');
      expect(msg).toContain('utilisateurs');
    });

    it('le message ne contient aucun détail interne (stack, query, id)', async () => {
      const guard = new QuotaGuard(
        makeReflector('users'),
        makeBillingService(5) as never,
        makePrisma(5) as never,
      );
      const context = makeContext();

      const err = await guard.canActivate(context as never).catch((e: unknown) => e);
      const msg = (err as ForbiddenException).message;

      expect(msg).not.toContain(ORG_ID);
      expect(msg).not.toContain('plan-1');
    });

    it('laisse passer si aucune métadonnée @CheckQuota', async () => {
      const guard = new QuotaGuard(
        makeReflector(undefined),
        makeBillingService(5) as never,
        makePrisma(10) as never,
      );
      const context = makeContext();

      const result = await guard.canActivate(context as never);

      expect(result).toBe(true);
    });

    it('lève InternalServerErrorException si getSubscription échoue', async () => {
      const billingService = {
        getSubscription: jest.fn().mockRejectedValue(new Error('DB down')),
      };
      const guard = new QuotaGuard(
        makeReflector('users'),
        billingService as never,
        makePrisma(0) as never,
      );
      const context = makeContext();

      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('lève ForbiddenException quand count === max (exactement à la limite)', async () => {
      const guard = new QuotaGuard(
        makeReflector('users'),
        makeBillingService(5) as never,
        makePrisma(5) as never,
      );
      await expect(guard.canActivate(makeContext() as never)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('vérifie le bon QUOTA_RESOURCE_KEY dans le reflector', async () => {
      const reflector = makeReflector('users');
      const guard = new QuotaGuard(
        reflector,
        makeBillingService(5) as never,
        makePrisma(3) as never,
      );
      await guard.canActivate(makeContext() as never);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
        QUOTA_RESOURCE_KEY,
        expect.any(Array),
      );
    });
  });
});
