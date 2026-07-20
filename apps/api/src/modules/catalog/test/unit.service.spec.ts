import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { UnitService } from '../unit.service';
import { PrismaService } from '../../../common/prisma.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'aaaa0000-0000-0000-0000-000000000000';
const ORG_B = 'bbbb0000-0000-0000-0000-000000000000';
const BASE_ID = 'base0000-0000-0000-0000-000000000000';
const DERIVED_ID = 'deriv000-0000-0000-0000-000000000000';
const DEEP_BASE_ID = 'deep0000-0000-0000-0000-000000000000';

function makeUnit(overrides: Partial<{
  id: string;
  organizationId: string;
  name: string;
  shortName: string;
  baseUnitId: string | null;
  baseUnit: { id: string; name: string; shortName: string } | null;
  operator: string;
  operatorValue: Decimal;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: BASE_ID,
    organizationId: ORG_A,
    name: 'Pièce',
    shortName: 'pcs',
    baseUnitId: null,
    baseUnit: null,
    operator: '*',
    operatorValue: new Decimal('1'),
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

type PrismaMock = {
  unit: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  product: {
    count: jest.Mock;
  };
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('UnitService', () => {
  let service: UnitService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    const mock: PrismaMock = {
      unit: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      product: {
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module = await Test.createTestingModule({
      providers: [UnitService, { provide: PrismaService, useValue: mock }],
    }).compile();

    service = module.get(UnitService);
    prisma = mock;
  });

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it("ne retourne que les unités de l'organisation scopée", async () => {
      const unit = makeUnit();
      prisma.unit.findMany.mockResolvedValue([unit]);
      prisma.unit.count.mockResolvedValue(1);

      const result = await service.findAll(ORG_A, 1, 20);

      expect(prisma.unit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG_A, deletedAt: null } }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe('Pièce');
    });

    it('exclut les unités soft-deleted', async () => {
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.unit.count.mockResolvedValue(0);

      const result = await service.findAll(ORG_A, 1, 20);

      const callArg = prisma.unit.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(callArg.where).toMatchObject({ deletedAt: null });
      expect(result.data).toHaveLength(0);
    });
  });

  // ── findOne ──────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('lève NotFoundException si l\'unité est introuvable', async () => {
      prisma.unit.findUnique.mockResolvedValue(null);
      await expect(service.findOne(BASE_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('lève NotFoundException si l\'unité est soft-deleted', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit({ deletedAt: new Date() }));
      await expect(service.findOne(BASE_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('lève ForbiddenException si l\'unité appartient à une autre org', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit({ organizationId: ORG_B }));
      await expect(service.findOne(BASE_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it('retourne l\'unité si tout est valide', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit());
      const result = await service.findOne(BASE_ID, ORG_A);
      expect(result.name).toBe('Pièce');
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('crée une unité de base sans baseUnitId', async () => {
      const unit = makeUnit();
      prisma.unit.create.mockResolvedValue(unit);

      const result = await service.create(ORG_A, {
        name: 'Pièce',
        shortName: 'pcs',
        operator: '*',
        operatorValue: '1',
      });

      expect(result.name).toBe('Pièce');
      expect(prisma.unit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ organizationId: ORG_A, baseUnitId: null }),
        }),
      );
    });

    it('crée une unité dérivée si la parente est une unité de base', async () => {
      // La parente est une unité de base (baseUnitId: null)
      const parentBase = { organizationId: ORG_A, baseUnitId: null, deletedAt: null };
      prisma.unit.findUnique.mockResolvedValue(parentBase);

      const derived = makeUnit({
        id: DERIVED_ID,
        name: 'Carton',
        shortName: 'ctn',
        baseUnitId: BASE_ID,
        operator: '*',
        operatorValue: new Decimal('12'),
      });
      prisma.unit.create.mockResolvedValue(derived);

      const result = await service.create(ORG_A, {
        name: 'Carton',
        shortName: 'ctn',
        baseUnitId: BASE_ID,
        operator: '*',
        operatorValue: '12',
      });

      expect(result.name).toBe('Carton');
      expect(result.baseUnitId).toBe(BASE_ID);
    });

    it('lève BadRequestException si la parente est elle-même une unité dérivée (hiérarchie profonde)', async () => {
      // La parente est déjà dérivée (baseUnitId non null)
      const deepParent = { organizationId: ORG_A, baseUnitId: DEEP_BASE_ID, deletedAt: null };
      prisma.unit.findUnique.mockResolvedValue(deepParent);

      await expect(
        service.create(ORG_A, {
          name: 'Sous-Carton',
          shortName: 'sc',
          baseUnitId: DERIVED_ID,
          operator: '*',
          operatorValue: '6',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('lève BadRequestException si la parente appartient à une autre org', async () => {
      const foreignParent = { organizationId: ORG_B, baseUnitId: null, deletedAt: null };
      prisma.unit.findUnique.mockResolvedValue(foreignParent);

      await expect(
        service.create(ORG_A, {
          name: 'Carton',
          shortName: 'ctn',
          baseUnitId: BASE_ID,
          operator: '*',
          operatorValue: '12',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('P2002 sur le nom → ConflictException', async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['unique_unit_name_active'] },
      });
      prisma.unit.findUnique.mockResolvedValue(null); // pas de baseUnitId → pas de lookup parent
      prisma.unit.create.mockRejectedValue(err);

      await expect(
        service.create(ORG_A, { name: 'Pièce', shortName: 'pcs2', operator: '*', operatorValue: '1' }),
      ).rejects.toThrow(ConflictException);
    });

    it('P2002 sur le shortName → ConflictException avec champ identifié', async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['unique_unit_short_name_active'] },
      });
      prisma.unit.create.mockRejectedValue(err);

      await expect(
        service.create(ORG_A, { name: 'Pièce2', shortName: 'pcs', operator: '*', operatorValue: '1' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('lève BadRequestException si l\'unité a des sous-unités actives', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit());
      prisma.unit.count.mockResolvedValue(2); // 2 sous-unités actives

      await expect(service.remove(BASE_ID, ORG_A)).rejects.toThrow(BadRequestException);
    });

    it('effectue un soft-delete si aucune sous-unité ni produit actif', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit());
      prisma.unit.count.mockResolvedValue(0);
      prisma.product.count.mockResolvedValue(0);
      prisma.unit.update.mockResolvedValue({ ...makeUnit(), deletedAt: new Date() });

      await service.remove(BASE_ID, ORG_A);

      expect(prisma.unit.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BASE_ID },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('lève BadRequestException si des produits actifs utilisent l\'unité', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit());
      prisma.unit.count.mockResolvedValue(0); // pas de sous-unités
      prisma.product.count.mockResolvedValue(3); // 3 produits actifs

      await expect(service.remove(BASE_ID, ORG_A)).rejects.toThrow(BadRequestException);
    });

    it('lève ForbiddenException si l\'unité appartient à une autre org', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit({ organizationId: ORG_B }));
      await expect(service.remove(BASE_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('lève NotFoundException si l\'unité est introuvable', async () => {
      prisma.unit.findUnique.mockResolvedValue(null);
      await expect(service.update(BASE_ID, ORG_A, { name: 'Nouveau' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('met à jour le nom et retourne le résultat', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit());
      prisma.unit.update.mockResolvedValue(makeUnit({ name: 'Kilogramme' }));

      const result = await service.update(BASE_ID, ORG_A, { name: 'Kilogramme' });
      expect(result.name).toBe('Kilogramme');
    });

    it('lève BadRequestException si on modifie baseUnitId avec des sous-unités actives', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnit());
      prisma.unit.count.mockResolvedValue(1); // 1 sous-unité active

      await expect(
        service.update(BASE_ID, ORG_A, { baseUnitId: DERIVED_ID }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
