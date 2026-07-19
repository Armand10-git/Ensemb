import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RegistrationService, computeTrialPeriod } from '../registration.service';
import { RESERVED_SUBDOMAINS } from '../dto/register-organization.dto';

const ORG_ID   = 'aaaaaaaa-0000-4000-a000-000000000001';
const USER_ID  = 'aaaaaaaa-0000-4000-a000-000000000002';
const ROLE_ID  = 'aaaaaaaa-0000-4000-a000-000000000003';
const PLAN_ID  = 'aaaaaaaa-0000-4000-a000-000000000004';
const SUB_ID   = 'aaaaaaaa-0000-4000-a000-000000000005';

const LAUNCH_PROMO_ENDS_AT = new Date('2026-09-30T23:59:59Z');

const VALID_DTO = {
  subdomain: 'boutique-durand',
  organizationName: 'Boutique Durand',
  adminFirstname: 'Jean',
  adminLastname: 'Durand',
  adminEmail: 'jean@boutique-durand.com',
  adminPassword: 'MotDePasse123',
};

const makeTx = (overrides: Record<string, unknown> = {}) => ({
  platformSetting: {
    findUnique: jest.fn().mockResolvedValue({ value: '"2026-09-30T23:59:59Z"' }),
    ...((overrides['platformSetting'] as Record<string, unknown>) ?? {}),
  },
  plan: {
    findUnique: jest.fn().mockResolvedValue({ id: PLAN_ID, trialDurationDays: 30 }),
    ...((overrides['plan'] as Record<string, unknown>) ?? {}),
  },
  permission: {
    findMany: jest.fn().mockResolvedValue([{ id: 'perm-1' }, { id: 'perm-2' }]),
  },
  organization: {
    create: jest.fn().mockResolvedValue({ id: ORG_ID, subdomain: VALID_DTO.subdomain }),
  },
  role: {
    create: jest.fn().mockResolvedValue({ id: ROLE_ID }),
  },
  user: {
    create: jest.fn().mockResolvedValue({ id: USER_ID }),
  },
  roleOnUser: {
    create: jest.fn().mockResolvedValue({}),
  },
  subscription: {
    create: jest.fn().mockResolvedValue({ id: SUB_ID }),
  },
});

const makePrisma = (overrides: Record<string, unknown> = {}, txOverrides: Record<string, unknown> = {}) => {
  const tx = makeTx(txOverrides);
  return {
    organization: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...((overrides['organization'] as Record<string, unknown>) ?? {}),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    ...overrides,
    _tx: tx,
  };
};

// ─── computeTrialPeriod ────────────────────────────────────────────────────────

describe('computeTrialPeriod', () => {
  const now = new Date('2026-07-19T00:00:00Z');

  it('pendant la fenêtre de lancement : retourne launchPromoEndsAt', () => {
    const launchPromoEndsAt = new Date('2026-09-30T23:59:59Z');
    const result = computeTrialPeriod(now, launchPromoEndsAt, 30);
    expect(result).toEqual(launchPromoEndsAt);
  });

  it('après la fenêtre de lancement : retourne now + trialDurationDays', () => {
    const launchPromoEndsAt = new Date('2026-06-30T23:59:59Z'); // dans le passé
    const result = computeTrialPeriod(now, launchPromoEndsAt, 30);
    expect(result).toEqual(new Date('2026-08-18T00:00:00Z'));
  });

  it('launchPromoEndsAt null : retourne now + trialDurationDays', () => {
    const result = computeTrialPeriod(now, null, 30);
    expect(result).toEqual(new Date('2026-08-18T00:00:00Z'));
  });

  it('respecte un trialDurationDays personnalisé', () => {
    const result = computeTrialPeriod(now, null, 14);
    expect(result).toEqual(new Date('2026-08-02T00:00:00Z'));
  });
});

// ─── RegistrationService.checkSubdomainAvailability ───────────────────────────

describe('RegistrationService', () => {
  describe('checkSubdomainAvailability', () => {
    it('retourne { available: true } si le sous-domaine est libre', async () => {
      const prisma = makePrisma();
      const service = new RegistrationService(prisma as never);

      const result = await service.checkSubdomainAvailability('boutique-durand');

      expect(result).toEqual({ available: true });
      expect(prisma.organization.findUnique).toHaveBeenCalledWith({
        where: { subdomain: 'boutique-durand' },
        select: { id: true },
      });
    });

    it('retourne { available: false } si le sous-domaine est pris', async () => {
      const prisma = makePrisma({
        organization: { findUnique: jest.fn().mockResolvedValue({ id: ORG_ID }) },
      });
      const service = new RegistrationService(prisma as never);

      expect(await service.checkSubdomainAvailability('boutique-durand')).toEqual({ available: false });
    });

    it.each(RESERVED_SUBDOMAINS)(
      'retourne { available: false } sans requête DB pour "%s"',
      async (reserved) => {
        const prisma = makePrisma();
        const service = new RegistrationService(prisma as never);

        expect(await service.checkSubdomainAvailability(reserved)).toEqual({ available: false });
        expect(prisma.organization.findUnique).not.toHaveBeenCalled();
      },
    );
  });

  // ─── RegistrationService.register ─────────────────────────────────────────

  describe('register', () => {
    it('renvoie organizationId, subdomain et adminUserId', async () => {
      const prisma = makePrisma();
      const service = new RegistrationService(prisma as never);

      const result = await service.register(VALID_DTO);

      expect(result).toEqual({
        organizationId: ORG_ID,
        subdomain: VALID_DTO.subdomain,
        adminUserId: USER_ID,
      });
    });

    it('pendant la fenêtre de lancement : trialEndsAt = launchPromoEndsAt', async () => {
      const prisma = makePrisma();
      const service = new RegistrationService(prisma as never);

      await service.register(VALID_DTO);

      const { _tx } = prisma as unknown as { _tx: ReturnType<typeof makeTx> };
      const orgCreate = (_tx.organization.create as jest.Mock).mock.calls[0][0] as {
        data: { trialEndsAt: Date };
      };
      expect(orgCreate.data.trialEndsAt).toEqual(LAUNCH_PROMO_ENDS_AT);
    });

    it('après la fenêtre : trialEndsAt ≈ now + trialDurationDays', async () => {
      const pastDate = new Date('2026-06-30T23:59:59Z');
      const prisma = makePrisma({}, {
        platformSetting: {
          findUnique: jest.fn().mockResolvedValue({ value: `"${pastDate.toISOString()}"` }),
        },
      });
      const service = new RegistrationService(prisma as never);

      const before = Date.now();
      await service.register(VALID_DTO);
      const after = Date.now();

      const { _tx } = prisma as unknown as { _tx: ReturnType<typeof makeTx> };
      const orgCreate = (_tx.organization.create as jest.Mock).mock.calls[0][0] as {
        data: { trialEndsAt: Date };
      };
      const trialEndsAt = orgCreate.data.trialEndsAt.getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(trialEndsAt).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
      expect(trialEndsAt).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
    });

    it('launchPromoEndsAt absent (null) : trialEndsAt ≈ now + 30j', async () => {
      const prisma = makePrisma({}, {
        platformSetting: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      });
      const service = new RegistrationService(prisma as never);

      const before = Date.now();
      await service.register(VALID_DTO);
      const after = Date.now();

      const { _tx } = prisma as unknown as { _tx: ReturnType<typeof makeTx> };
      const orgCreate = (_tx.organization.create as jest.Mock).mock.calls[0][0] as {
        data: { trialEndsAt: Date };
      };
      const trialEndsAt = orgCreate.data.trialEndsAt.getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(trialEndsAt).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
      expect(trialEndsAt).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
    });

    it('crée une Subscription TRIALING avec currentPeriodEnd = trialEndsAt', async () => {
      const prisma = makePrisma();
      const service = new RegistrationService(prisma as never);

      await service.register(VALID_DTO);

      const { _tx } = prisma as unknown as { _tx: ReturnType<typeof makeTx> };
      const subCreate = (_tx.subscription.create as jest.Mock).mock.calls[0][0] as {
        data: { organizationId: string; planId: string; status: string; currentPeriodEnd: Date };
      };
      expect(subCreate.data.organizationId).toBe(ORG_ID);
      expect(subCreate.data.planId).toBe(PLAN_ID);
      expect(subCreate.data.status).toBe('TRIALING');
      expect(subCreate.data.currentPeriodEnd).toEqual(LAUNCH_PROMO_ENDS_AT);
    });

    it('assigne toutes les permissions du catalogue au rôle administrateur', async () => {
      const prisma = makePrisma();
      const service = new RegistrationService(prisma as never);

      await service.register(VALID_DTO);

      const { _tx } = prisma as unknown as { _tx: ReturnType<typeof makeTx> };
      const roleCreate = (_tx.role.create as jest.Mock).mock.calls[0][0] as {
        data: { permissions: { create: { permissionId: string }[] } };
      };
      expect(roleCreate.data.permissions.create).toEqual([
        { permissionId: 'perm-1' },
        { permissionId: 'perm-2' },
      ]);
    });

    it('lance InternalServerErrorException si le plan starter est absent', async () => {
      const prisma = makePrisma({}, {
        plan: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      const service = new RegistrationService(prisma as never);

      await expect(service.register(VALID_DTO)).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('lance ConflictException si le sous-domaine est déjà pris (check applicatif)', async () => {
      const prisma = makePrisma({
        organization: { findUnique: jest.fn().mockResolvedValue({ id: ORG_ID }) },
      });
      const service = new RegistrationService(prisma as never);

      await expect(service.register(VALID_DTO)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('traduit P2002 en ConflictException (race condition entre check et création)', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      const prisma = makePrisma({
        $transaction: jest.fn().mockRejectedValue(p2002),
      });
      const service = new RegistrationService(prisma as never);

      const err = await service.register(VALID_DTO).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toContain('disponible');
      expect((err as ConflictException).message).not.toContain('existe');
    });

    it('propage les erreurs non-P2002 sans les masquer', async () => {
      const dbError = new Error('connexion perdue');
      const prisma = makePrisma({
        $transaction: jest.fn().mockRejectedValue(dbError),
      });
      const service = new RegistrationService(prisma as never);

      await expect(service.register(VALID_DTO)).rejects.toBe(dbError);
    });

    it('le message ConflictException est neutre (anti-énumération)', async () => {
      const prisma = makePrisma({
        organization: { findUnique: jest.fn().mockResolvedValue({ id: ORG_ID }) },
      });
      const service = new RegistrationService(prisma as never);

      const err = await service.register(VALID_DTO).catch((e: unknown) => e);
      const msg = (err as ConflictException).message;
      expect(msg).not.toContain('existe');
      expect(msg).not.toContain('organisation');
      expect(msg).toContain('disponible');
    });
  });
});
