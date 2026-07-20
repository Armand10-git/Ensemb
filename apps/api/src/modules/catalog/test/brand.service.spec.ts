import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { BrandService } from '../brand.service';
import { PrismaService } from '../../../common/prisma.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'org-aaaa-aaaa-aaaa-aaaa';
const ORG_B = 'org-bbbb-bbbb-bbbb-bbbb';
const BRAND_ID = 'brand-1111-1111-1111-1111';

function makeBrand(overrides: Partial<{
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  image: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: BRAND_ID,
    organizationId: ORG_A,
    name: 'Samsung',
    description: null,
    image: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

type PrismaMock = {
  brand: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('BrandService', () => {
  let service: BrandService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    const mock: PrismaMock = {
      brand: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        BrandService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();

    service = module.get(BrandService);
    prisma = mock;
  });

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it("ne retourne que les marques de l'organisation scopée", async () => {
      const brand = makeBrand();
      prisma.brand.findMany.mockResolvedValue([brand]);
      prisma.brand.count.mockResolvedValue(1);

      const result = await service.findAll(ORG_A, 1, 20);

      expect(prisma.brand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG_A, deletedAt: null } }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe('Samsung');
    });

    it('exclut les marques soft-deleted', async () => {
      prisma.brand.findMany.mockResolvedValue([]);
      prisma.brand.count.mockResolvedValue(0);

      const result = await service.findAll(ORG_A, 1, 20);

      const callArg = prisma.brand.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(callArg.where).toMatchObject({ deletedAt: null });
      expect(result.data).toHaveLength(0);
    });

    it("ne retourne pas les marques d'une autre organisation", async () => {
      prisma.brand.findMany.mockImplementation(
        ({ where }: { where: { organizationId: string } }) => {
          if (where.organizationId === ORG_B) return Promise.resolve([makeBrand({ organizationId: ORG_B })]);
          return Promise.resolve([]);
        },
      );
      prisma.brand.count.mockResolvedValue(0);

      const resultA = await service.findAll(ORG_A, 1, 20);
      expect(resultA.data).toHaveLength(0);
    });
  });

  // ── findOne ──────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it("lève NotFoundException si la marque est introuvable", async () => {
      prisma.brand.findUnique.mockResolvedValue(null);
      await expect(service.findOne(BRAND_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève NotFoundException si la marque est soft-deleted", async () => {
      prisma.brand.findUnique.mockResolvedValue(makeBrand({ deletedAt: new Date() }));
      await expect(service.findOne(BRAND_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si la marque appartient à une autre org", async () => {
      prisma.brand.findUnique.mockResolvedValue(makeBrand({ organizationId: ORG_B }));
      await expect(service.findOne(BRAND_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it("retourne la marque si tout est valide", async () => {
      prisma.brand.findUnique.mockResolvedValue(makeBrand());
      const result = await service.findOne(BRAND_ID, ORG_A);
      expect(result.name).toBe('Samsung');
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('crée une marque et retourne le résultat', async () => {
      const brand = makeBrand({ name: 'LG' });
      prisma.brand.create.mockResolvedValue(brand);

      const result = await service.create(ORG_A, { name: 'LG' });
      expect(result.name).toBe('LG');
      expect(prisma.brand.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG_A }) }),
      );
    });

    it("P2002 sur le nom → ConflictException avec nom mentionné", async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['unique_brand_name_active'] },
      });
      prisma.brand.create.mockRejectedValue(err);

      await expect(service.create(ORG_A, { name: 'Samsung' })).rejects.toThrow(ConflictException);
    });

    it('crée une marque avec image et description', async () => {
      const brand = makeBrand({
        name: 'Apple',
        description: 'Technologie innovante',
        image: 'https://apple.com/logo.png',
      });
      prisma.brand.create.mockResolvedValue(brand);

      const result = await service.create(ORG_A, {
        name: 'Apple',
        description: 'Technologie innovante',
        image: 'https://apple.com/logo.png',
      });
      expect(result.name).toBe('Apple');
      expect(result.image).toBe('https://apple.com/logo.png');
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it("effectue un soft-delete sans condition sur les produits", async () => {
      prisma.brand.findUnique.mockResolvedValue(makeBrand());
      prisma.brand.update.mockResolvedValue({ ...makeBrand(), deletedAt: new Date() });

      await service.remove(BRAND_ID, ORG_A);

      expect(prisma.brand.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BRAND_ID },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it("lève ForbiddenException si la marque appartient à une autre org", async () => {
      prisma.brand.findUnique.mockResolvedValue(makeBrand({ organizationId: ORG_B }));
      await expect(service.remove(BRAND_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it("lève NotFoundException si la marque n'existe pas", async () => {
      prisma.brand.findUnique.mockResolvedValue(null);
      await expect(service.remove(BRAND_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it("lève NotFoundException si la marque est introuvable", async () => {
      prisma.brand.findUnique.mockResolvedValue(null);
      await expect(service.update(BRAND_ID, ORG_A, { name: 'Nouveau' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('met à jour une marque et retourne le résultat', async () => {
      prisma.brand.findUnique.mockResolvedValue(makeBrand());
      prisma.brand.update.mockResolvedValue(makeBrand({ name: 'Apple' }));

      const result = await service.update(BRAND_ID, ORG_A, { name: 'Apple' });
      expect(result.name).toBe('Apple');
    });

    it("P2002 sur le nom en update → ConflictException", async () => {
      prisma.brand.findUnique.mockResolvedValue(makeBrand());
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['unique_brand_name_active'] },
      });
      prisma.brand.update.mockRejectedValue(err);

      await expect(service.update(BRAND_ID, ORG_A, { name: 'LG' })).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
