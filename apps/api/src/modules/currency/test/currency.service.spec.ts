import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CurrencyService } from '../currency.service';
import { PrismaService } from '../../../common/prisma.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const XAF_ID = 'cur-xaf-1111-1111-1111';
const EUR_ID = 'cur-eur-2222-2222-2222';
const ORG_ID = 'org-1111-1111-1111-1111';

function makeCurrency(overrides: Partial<{
  id: string;
  code: string;
  name: string;
  symbol: string;
  symbolPosition: 'BEFORE' | 'AFTER';
  decimalPlaces: number;
  isActive: boolean;
}> = {}) {
  return {
    id: XAF_ID,
    code: 'XAF',
    name: 'Franc CFA BEAC',
    symbol: 'XAF',
    symbolPosition: 'AFTER' as const,
    decimalPlaces: 0,
    isActive: true,
    ...overrides,
  };
}

type PrismaMock = {
  currency: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  organization: {
    update: jest.Mock;
  };
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('CurrencyService', () => {
  let service: CurrencyService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    const mock: PrismaMock = {
      currency: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      organization: {
        update: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        CurrencyService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();

    service = module.get(CurrencyService);
    prisma = mock;
  });

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('retourne uniquement les devises actives', async () => {
      const active = makeCurrency({ isActive: true });
      prisma.currency.findMany.mockResolvedValue([active]);

      const result = await service.findAll();

      expect(prisma.currency.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.code).toBe('XAF');
    });

    it('retourne une liste vide si aucune devise active', async () => {
      prisma.currency.findMany.mockResolvedValue([]);
      const result = await service.findAll();
      expect(result).toHaveLength(0);
    });
  });

  // ── findAllAdmin ─────────────────────────────────────────────────────────

  describe('findAllAdmin', () => {
    it('retourne toutes les devises (actives et inactives)', async () => {
      prisma.currency.findMany.mockResolvedValue([
        makeCurrency({ isActive: true }),
        makeCurrency({ id: EUR_ID, code: 'EUR', isActive: false }),
      ]);

      const result = await service.findAllAdmin();

      const callArg = prisma.currency.findMany.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg).not.toHaveProperty('where');
      expect(result).toHaveLength(2);
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('lève ConflictException si le code existe déjà', async () => {
      prisma.currency.findUnique.mockResolvedValue(makeCurrency());
      await expect(
        service.create({ code: 'XAF', name: 'XAF', symbol: 'XAF', symbolPosition: 'AFTER', decimalPlaces: 0, isActive: true }),
      ).rejects.toThrow(ConflictException);
    });

    it('crée la devise si le code est nouveau', async () => {
      prisma.currency.findUnique.mockResolvedValue(null);
      prisma.currency.create.mockResolvedValue(makeCurrency({ code: 'EUR', id: EUR_ID }));

      const result = await service.create({ code: 'EUR', name: 'Euro', symbol: '€', symbolPosition: 'BEFORE', decimalPlaces: 2, isActive: true });
      expect(result.code).toBe('EUR');
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it("lève NotFoundException si la devise n'existe pas", async () => {
      prisma.currency.findUnique.mockResolvedValue(null);
      await expect(service.update('non-existent', { name: 'Test' })).rejects.toThrow(NotFoundException);
    });

    it('met à jour les champs fournis uniquement', async () => {
      prisma.currency.findUnique.mockResolvedValue(makeCurrency());
      prisma.currency.update.mockResolvedValue(makeCurrency({ name: 'Franc CFA modifié' }));

      const result = await service.update(XAF_ID, { name: 'Franc CFA modifié' });
      expect(result.name).toBe('Franc CFA modifié');
      expect(prisma.currency.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: XAF_ID } }),
      );
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it("lève NotFoundException si la devise n'existe pas", async () => {
      prisma.currency.findUnique.mockResolvedValue(null);
      await expect(service.remove('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('désactive la devise (isActive = false) sans la supprimer', async () => {
      prisma.currency.findUnique.mockResolvedValue(makeCurrency());
      prisma.currency.update.mockResolvedValue(makeCurrency({ isActive: false }));

      await service.remove(XAF_ID);

      expect(prisma.currency.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: XAF_ID }, data: { isActive: false } }),
      );
    });
  });

  // ── updateDefaultCurrency ────────────────────────────────────────────────

  describe('updateDefaultCurrency', () => {
    it('lève NotFoundException si la devise est inactive', async () => {
      prisma.currency.findUnique.mockResolvedValue(null);
      await expect(service.updateDefaultCurrency(ORG_ID, XAF_ID)).rejects.toThrow(NotFoundException);
    });

    it('met à jour Organization.defaultCurrencyId', async () => {
      prisma.currency.findUnique.mockResolvedValue(makeCurrency({ isActive: true }));
      prisma.organization.update.mockResolvedValue({});

      const result = await service.updateDefaultCurrency(ORG_ID, XAF_ID);

      expect(prisma.organization.update).toHaveBeenCalledWith({
        where: { id: ORG_ID },
        data: { defaultCurrencyId: XAF_ID },
      });
      expect(result.defaultCurrencyId).toBe(XAF_ID);
    });
  });
});
