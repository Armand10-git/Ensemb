import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { CategoryService } from '../catalog.service';
import { PrismaService } from '../../../common/prisma.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'org-aaaa-aaaa-aaaa-aaaa';
const ORG_B = 'org-bbbb-bbbb-bbbb-bbbb';
const CAT_ID = 'cat-1111-1111-1111-1111';

function makeCategory(overrides: Partial<{
  id: string;
  organizationId: string;
  code: string;
  name: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: CAT_ID,
    organizationId: ORG_A,
    code: 'ELEC',
    name: 'Électronique',
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

type PrismaMock = {
  category: {
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

describe('CategoryService', () => {
  let service: CategoryService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    const mock: PrismaMock = {
      category: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      product: {
        count: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        CategoryService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();

    service = module.get(CategoryService);
    prisma = mock;
  });

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it("ne retourne que les catégories de l'organisation scopée", async () => {
      const cat = makeCategory();
      prisma.category.findMany.mockResolvedValue([cat]);
      prisma.category.count.mockResolvedValue(1);

      const result = await service.findAll(ORG_A, 1, 20);

      expect(prisma.category.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG_A, deletedAt: null } }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.code).toBe('ELEC');
    });

    it('exclut les catégories soft-deleted', async () => {
      prisma.category.findMany.mockResolvedValue([]);
      prisma.category.count.mockResolvedValue(0);

      const result = await service.findAll(ORG_A, 1, 20);

      const callArg = prisma.category.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(callArg.where).toMatchObject({ deletedAt: null });
      expect(result.data).toHaveLength(0);
    });

    it("ne retourne pas les catégories d'une autre organisation", async () => {
      prisma.category.findMany.mockImplementation(
        ({ where }: { where: { organizationId: string } }) => {
          if (where.organizationId === ORG_B) return Promise.resolve([makeCategory({ organizationId: ORG_B })]);
          return Promise.resolve([]);
        },
      );
      prisma.category.count.mockResolvedValue(0);

      const resultA = await service.findAll(ORG_A, 1, 20);
      expect(resultA.data).toHaveLength(0);
    });

    it('retourne la pagination correcte', async () => {
      prisma.category.findMany.mockResolvedValue([makeCategory()]);
      prisma.category.count.mockResolvedValue(35);

      const result = await service.findAll(ORG_A, 2, 10);

      expect(result.total).toBe(35);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
    });
  });

  // ── findOne ──────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it("lève NotFoundException si la catégorie est introuvable", async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      await expect(service.findOne(CAT_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève NotFoundException si la catégorie est soft-deleted", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory({ deletedAt: new Date() }));
      await expect(service.findOne(CAT_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si la catégorie appartient à une autre org", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory({ organizationId: ORG_B }));
      await expect(service.findOne(CAT_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it("retourne la catégorie si tout est valide", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      const result = await service.findOne(CAT_ID, ORG_A);
      expect(result.code).toBe('ELEC');
      expect(result.name).toBe('Électronique');
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('crée une catégorie et retourne le résultat', async () => {
      const cat = makeCategory({ code: 'ALI', name: 'Alimentation' });
      prisma.category.create.mockResolvedValue(cat);

      const result = await service.create(ORG_A, { code: 'ALI', name: 'Alimentation' });
      expect(result.code).toBe('ALI');
      expect(prisma.category.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG_A }) }),
      );
    });

    it("P2002 sur le code → ConflictException avec mention du champ 'code'", async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['unique_category_code_active'] },
      });
      prisma.category.create.mockRejectedValue(err);

      await expect(service.create(ORG_A, { code: 'ELEC', name: 'Électro' })).rejects.toThrow(
        ConflictException,
      );
    });

    it("P2002 sur le nom → ConflictException avec mention du champ 'nom'", async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['unique_category_name_active'] },
      });
      prisma.category.create.mockRejectedValue(err);

      const ex = service.create(ORG_A, { code: 'NEW', name: 'Électronique' });
      await expect(ex).rejects.toThrow(ConflictException);
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it("lève BadRequestException si des produits actifs sont rattachés", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.product.count.mockResolvedValue(3);

      await expect(service.remove(CAT_ID, ORG_A)).rejects.toThrow(BadRequestException);
    });

    it("effectue un soft-delete si aucun produit actif n'est rattaché", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.product.count.mockResolvedValue(0);
      prisma.category.update.mockResolvedValue({ ...makeCategory(), deletedAt: new Date() });

      await service.remove(CAT_ID, ORG_A);

      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CAT_ID },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it("lève ForbiddenException si la catégorie appartient à une autre org", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory({ organizationId: ORG_B }));
      await expect(service.remove(CAT_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it("le message BadRequestException mentionne le nombre de produits", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.product.count.mockResolvedValue(5);

      await expect(service.remove(CAT_ID, ORG_A)).rejects.toThrow(
        expect.objectContaining({ message: expect.stringContaining('5') }),
      );
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it("lève NotFoundException si la catégorie est introuvable", async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      await expect(service.update(CAT_ID, ORG_A, { name: 'Nouveau' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('met à jour une catégorie et retourne le résultat', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.update.mockResolvedValue(makeCategory({ name: 'Nouveau' }));

      const result = await service.update(CAT_ID, ORG_A, { name: 'Nouveau' });
      expect(result.name).toBe('Nouveau');
    });
  });
});
