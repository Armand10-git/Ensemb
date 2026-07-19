import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RegistrationService, computeTrialEndsAt } from '../registration.service';
import { RESERVED_SUBDOMAINS } from '../dto/register-organization.dto';

const ORG_ID = 'aaaaaaaa-0000-4000-a000-000000000001';
const USER_ID = 'aaaaaaaa-0000-4000-a000-000000000002';
const ROLE_ID = 'aaaaaaaa-0000-4000-a000-000000000003';

const VALID_DTO = {
  subdomain: 'boutique-durand',
  organizationName: 'Boutique Durand',
  adminFirstname: 'Jean',
  adminLastname: 'Durand',
  adminEmail: 'jean@boutique-durand.com',
  adminPassword: 'MotDePasse123',
};

const makeTx = () => ({
  organization: {
    create: jest.fn().mockResolvedValue({ id: ORG_ID, subdomain: VALID_DTO.subdomain }),
  },
  permission: {
    findMany: jest.fn().mockResolvedValue([{ id: 'perm-1' }, { id: 'perm-2' }]),
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
});

const makePrisma = (overrides: Record<string, unknown> = {}) => {
  const tx = makeTx();
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

// ─── computeTrialEndsAt ────────────────────────────────────────────────────────

describe('computeTrialEndsAt', () => {
  it('retourne now + 30 jours par défaut', () => {
    const now = new Date('2026-07-19T00:00:00Z');
    const result = computeTrialEndsAt(now);
    expect(result).toEqual(new Date('2026-08-18T00:00:00Z'));
  });

  it('respecte le paramètre trialDays', () => {
    const now = new Date('2026-07-19T00:00:00Z');
    expect(computeTrialEndsAt(now, 14)).toEqual(new Date('2026-08-02T00:00:00Z'));
  });

  it('retourne une date strictement dans le futur', () => {
    const now = new Date();
    expect(computeTrialEndsAt(now).getTime()).toBeGreaterThan(now.getTime());
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

    it('crée l\'organisation avec trialEndsAt ≈ now + 30j', async () => {
      const before = new Date();
      const prisma = makePrisma();
      const service = new RegistrationService(prisma as never);

      await service.register(VALID_DTO);

      const { _tx } = prisma as unknown as { _tx: ReturnType<typeof makeTx> };
      const callArg = (_tx.organization.create as jest.Mock).mock.calls[0][0] as {
        data: { trialEndsAt: Date };
      };
      const trialEndsAt = callArg.data.trialEndsAt;
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const diff = trialEndsAt.getTime() - before.getTime();
      expect(diff).toBeGreaterThanOrEqual(thirtyDaysMs - 1000);
      expect(diff).toBeLessThanOrEqual(thirtyDaysMs + 5000);
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
