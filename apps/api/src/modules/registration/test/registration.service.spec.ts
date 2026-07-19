import { ConflictException } from '@nestjs/common';
import { RegistrationService } from '../registration.service';
import { RESERVED_SUBDOMAINS } from '../dto/register-organization.dto';

const ORG_ID = 'org-uuid';
const USER_ID = 'user-uuid';
const ROLE_ID = 'role-uuid';

const VALID_DTO = {
  subdomain: 'boutique-durand',
  organizationName: 'Boutique Durand',
  adminFirstname: 'Jean',
  adminLastname: 'Durand',
  adminEmail: 'jean@boutique-durand.com',
  adminPassword: 'MotDePasse123',
};

const makePrisma = (overrides: Record<string, unknown> = {}) => ({
  organization: {
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: ORG_ID, subdomain: VALID_DTO.subdomain }),
    ...((overrides['organization'] as Record<string, unknown>) ?? {}),
  },
  permission: {
    findMany: jest.fn().mockResolvedValue([{ id: 'perm-1' }, { id: 'perm-2' }]),
    ...((overrides['permission'] as Record<string, unknown>) ?? {}),
  },
  role: {
    create: jest.fn().mockResolvedValue({ id: ROLE_ID }),
    ...((overrides['role'] as Record<string, unknown>) ?? {}),
  },
  user: {
    create: jest.fn().mockResolvedValue({ id: USER_ID }),
    ...((overrides['user'] as Record<string, unknown>) ?? {}),
  },
  roleOnUser: {
    create: jest.fn().mockResolvedValue({}),
    ...((overrides['roleOnUser'] as Record<string, unknown>) ?? {}),
  },
  $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
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
    };
    return fn(tx);
  }),
  ...overrides,
});

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

      const result = await service.checkSubdomainAvailability('boutique-durand');

      expect(result).toEqual({ available: false });
    });

    it.each(RESERVED_SUBDOMAINS)(
      'retourne { available: false } pour le sous-domaine reserve "%s"',
      async (reserved) => {
        const prisma = makePrisma();
        const service = new RegistrationService(prisma as never);

        const result = await service.checkSubdomainAvailability(reserved);

        expect(result).toEqual({ available: false });
        // Ne doit pas interroger la base pour les sous-domaines réservés
        expect(prisma.organization.findUnique).not.toHaveBeenCalled();
      },
    );
  });

  describe('register', () => {
    it('calcule trialEndsAt a environ 30 jours dans le futur', async () => {
      const prisma = makePrisma();
      const service = new RegistrationService(prisma as never);
      const before = Date.now();

      await service.register(VALID_DTO);

      const txMock = (prisma.$transaction as jest.Mock).mock.calls[0];
      expect(txMock).toBeDefined();

      // On vérifie via la création d'organisation dans la transaction
      const txArg = (prisma.$transaction as jest.Mock).mock.calls[0][0];
      expect(txArg).toBeInstanceOf(Function);

      // Réexécuter la transaction avec un TX spy pour capturer trialEndsAt
      const txSpy = {
        organization: {
          create: jest.fn().mockImplementation((args: { data: { trialEndsAt: Date } }) => {
            const trialEndsAt = args.data.trialEndsAt;
            const diff = trialEndsAt.getTime() - before;
            const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
            expect(diff).toBeGreaterThanOrEqual(thirtyDaysMs - 1000);
            expect(diff).toBeLessThanOrEqual(thirtyDaysMs + 5000);
            return Promise.resolve({ id: ORG_ID, subdomain: VALID_DTO.subdomain });
          }),
        },
        permission: { findMany: jest.fn().mockResolvedValue([]) },
        role: { create: jest.fn().mockResolvedValue({ id: ROLE_ID }) },
        user: { create: jest.fn().mockResolvedValue({ id: USER_ID }) },
        roleOnUser: { create: jest.fn().mockResolvedValue({}) },
      };

      await txArg(txSpy);
    });

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

    it('lance ConflictException si le sous-domaine est deja pris', async () => {
      const prisma = makePrisma({
        organization: { findUnique: jest.fn().mockResolvedValue({ id: ORG_ID }) },
      });
      const service = new RegistrationService(prisma as never);

      await expect(service.register(VALID_DTO)).rejects.toBeInstanceOf(ConflictException);
      // Ne doit pas démarrer de transaction si le sous-domaine est indisponible
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('le message d\'erreur ne revele pas l\'existence de l\'organisation (anti-enumeration)', async () => {
      const prisma = makePrisma({
        organization: { findUnique: jest.fn().mockResolvedValue({ id: ORG_ID }) },
      });
      const service = new RegistrationService(prisma as never);

      try {
        await service.register(VALID_DTO);
        fail('Doit lancer une exception');
      } catch (e) {
        expect((e as ConflictException).message).not.toContain('existe');
        expect((e as ConflictException).message).not.toContain('organisation');
        expect((e as ConflictException).message).toContain('disponible');
      }
    });
  });
});
