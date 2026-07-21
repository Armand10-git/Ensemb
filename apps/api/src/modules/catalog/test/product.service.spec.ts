import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ProductService } from '../product.service';
import { PrismaService } from '../../../common/prisma.service';
import { UploadsService } from '../../uploads/uploads.service';
import { CreateProductSchema } from '../dto/create-product.dto';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B = 'bbbb0000-0000-0000-0000-000000000002';
const PROD_ID  = 'prod0000-0000-0000-0000-000000000001';
const CAT_ID   = 'cate0000-0000-0000-0000-000000000001';
const VAR_ID   = 'vari0000-0000-0000-0000-000000000001';
const S3_KEY   = 'aaaa0000-0000-0000-0000-000000000001/products/img.jpg';
const SIGNED   = 'https://s3.example.com/signed-url';

function makeProduct(overrides: Partial<{
  id: string; organizationId: string; image: string | null;
  deletedAt: Date | null; variants: unknown[];
}> = {}) {
  return {
    id: PROD_ID,
    organizationId: ORG_A,
    code: 'REF-001',
    barcodeType: null,
    name: 'Produit Test',
    cost: new Decimal('1000'),
    price: new Decimal('1500'),
    taxRate: new Decimal('0.1925'),
    taxMethod: 'percentage',
    image: null,
    note: null,
    stockAlert: 0,
    isVariant: false,
    isActive: true,
    categoryId: CAT_ID,
    brandId: null,
    unitId: null,
    unitSaleId: null,
    unitPurchaseId: null,
    category: { id: CAT_ID, code: 'TEST', name: 'Test Cat' },
    brand: null,
    unit: null,
    unitSale: null,
    unitPurchase: null,
    variants: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null,
    ...overrides,
  };
}

function makeCategory(overrides: Partial<{ organizationId: string; deletedAt: Date | null }> = {}) {
  return {
    organizationId: ORG_A,
    deletedAt: null,
    ...overrides,
  };
}

function makeVariant(overrides: Partial<{ productId: string; deletedAt: Date | null }> = {}) {
  return {
    id: VAR_ID,
    productId: PROD_ID,
    name: 'Rouge',
    deletedAt: null,
    ...overrides,
  };
}

// ─── Mock types ──────────────────────────────────────────────────────────────

type PrismaMock = {
  product:        { findMany: jest.Mock; findUnique: jest.Mock; count: jest.Mock; create: jest.Mock; update: jest.Mock; findUniqueOrThrow: jest.Mock };
  productVariant: { updateMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; create: jest.Mock; createMany: jest.Mock };
  category:       { findUnique: jest.Mock };
  brand:          { findUnique: jest.Mock };
  unit:           { findUnique: jest.Mock };
  $transaction:   jest.Mock;
};

type UploadsMock = {
  getSignedUrl: jest.Mock;
  uploadImage:  jest.Mock;
  deleteImage:  jest.Mock;
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('ProductService', () => {
  let service: ProductService;
  let prisma: PrismaMock;
  let uploads: UploadsMock;

  beforeEach(async () => {
    const prismaMock: PrismaMock = {
      product: {
        findMany:         jest.fn(),
        findUnique:       jest.fn(),
        findUniqueOrThrow:jest.fn(),
        count:            jest.fn(),
        create:           jest.fn(),
        update:           jest.fn(),
      },
      productVariant: {
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        update:     jest.fn(),
        create:     jest.fn(),
        createMany: jest.fn(),
      },
      category: { findUnique: jest.fn() },
      brand:    { findUnique: jest.fn() },
      unit:     { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };

    const uploadsMock: UploadsMock = {
      getSignedUrl: jest.fn().mockResolvedValue(SIGNED),
      uploadImage:  jest.fn().mockResolvedValue(S3_KEY),
      deleteImage:  jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        ProductService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: UploadsService, useValue: uploadsMock },
      ],
    }).compile();

    service = module.get(ProductService);
    prisma  = prismaMock;
    uploads = uploadsMock;
  });

  // ── findAll ────────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it("scope org — exclut les soft-deleted et génère imageUrl", async () => {
      const product = makeProduct({ image: S3_KEY });
      prisma.product.findMany.mockResolvedValue([product]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.findAll(ORG_A, 1, 20);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_A, deletedAt: null }) }),
      );
      expect(result.data[0]).toHaveProperty('imageUrl', SIGNED);
      expect(uploads.getSignedUrl).toHaveBeenCalledWith(S3_KEY);
    });

    it("imageUrl est null si aucune image", async () => {
      const product = makeProduct({ image: null });
      prisma.product.findMany.mockResolvedValue([product]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.findAll(ORG_A, 1, 20);

      expect(result.data[0]).toHaveProperty('imageUrl', null);
      expect(uploads.getSignedUrl).not.toHaveBeenCalled();
    });
  });

  // ── findOne ────────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it("lève NotFoundException si produit introuvable", async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.findOne(PROD_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève NotFoundException si soft-deleted", async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct({ deletedAt: new Date() }));
      await expect(service.findOne(PROD_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si autre org", async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct({ organizationId: ORG_B }));
      await expect(service.findOne(PROD_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });
  });

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    const baseDto = {
      code: 'REF-001',
      name: 'Produit Test',
      cost: '1000',
      price: '1500',
      categoryId: CAT_ID,
      taxRate: '0',
      taxMethod: 'percentage' as const,
      stockAlert: 0,
      isVariant: false,
    };

    it("lève ForbiddenException si categoryId appartient à une autre org", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory({ organizationId: ORG_B }));
      await expect(service.create(ORG_A, baseDto)).rejects.toThrow(ForbiddenException);
    });

    it("lève NotFoundException si categoryId inexistant", async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      await expect(service.create(ORG_A, baseDto)).rejects.toThrow(NotFoundException);
    });

    it("P2002 sur (organizationId, code) → ConflictException explicite", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['products_organizationId_code_key'] },
      });
      prisma.$transaction.mockRejectedValue(err);

      await expect(service.create(ORG_A, baseDto)).rejects.toThrow(ConflictException);
    });

    it("crée le produit dans une transaction et retourne imageUrl null", async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      const product = makeProduct();
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txMock = {
          product: {
            create: jest.fn().mockResolvedValue(product),
            findUniqueOrThrow: jest.fn().mockResolvedValue(product),
          },
          productVariant: { createMany: jest.fn() },
        };
        return fn(txMock);
      });

      const result = await service.create(ORG_A, baseDto);
      expect(result).toHaveProperty('imageUrl', null);
    });
  });

  // ── uploadImage ────────────────────────────────────────────────────────────

  describe('uploadImage', () => {
    const fakeFile = { buffer: Buffer.from('img'), size: 100, originalname: 'img.jpg' } as Express.Multer.File;

    it("supprime l'ancienne clé S3 et sauvegarde la nouvelle", async () => {
      const oldKey = 'org/products/old.jpg';
      prisma.product.findUnique.mockResolvedValue(makeProduct({ image: oldKey }));
      prisma.product.update.mockResolvedValue(makeProduct({ image: S3_KEY }));

      const result = await service.uploadImage(PROD_ID, ORG_A, fakeFile);

      expect(uploads.uploadImage).toHaveBeenCalledWith(ORG_A, 'products', fakeFile);
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PROD_ID }, data: { image: S3_KEY } }),
      );
      expect(uploads.deleteImage).toHaveBeenCalledWith(oldKey);
      expect(result).toHaveProperty('imageUrl', SIGNED);
    });

    it("ne supprime pas l'ancienne clé si aucune image précédente", async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct({ image: null }));
      prisma.product.update.mockResolvedValue(makeProduct({ image: S3_KEY }));

      await service.uploadImage(PROD_ID, ORG_A, fakeFile);
      expect(uploads.deleteImage).not.toHaveBeenCalled();
    });
  });

  // ── remove ─────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it("soft-delete du produit ET de ses variantes dans une transaction", async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const updateProduct = jest.fn().mockResolvedValue(makeProduct({ deletedAt: new Date() }));
      prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
      prisma.productVariant.updateMany = updateMany;
      prisma.product.update = updateProduct;

      await service.remove(PROD_ID, ORG_A);

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { productId: PROD_ID, deletedAt: null } }),
      );
      expect(updateProduct).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PROD_ID }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
      );
    });

    it("lève ForbiddenException si autre org", async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct({ organizationId: ORG_B }));
      await expect(service.remove(PROD_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });
  });

  // ── removeVariant ──────────────────────────────────────────────────────────

  describe('removeVariant', () => {
    it("lève NotFoundException si variante introuvable", async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.productVariant.findUnique.mockResolvedValue(null);
      await expect(service.removeVariant(PROD_ID, VAR_ID, ORG_A)).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si variante n'appartient pas au produit", async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.productVariant.findUnique.mockResolvedValue(
        makeVariant({ productId: 'autre-produit-id' }),
      );
      await expect(service.removeVariant(PROD_ID, VAR_ID, ORG_A)).rejects.toThrow(ForbiddenException);
    });

    it("soft-delete la variante si tout est valide", async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.productVariant.findUnique.mockResolvedValue(makeVariant());
      prisma.productVariant.update.mockResolvedValue({ ...makeVariant(), deletedAt: new Date() });

      await service.removeVariant(PROD_ID, VAR_ID, ORG_A);

      expect(prisma.productVariant.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: VAR_ID }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
      );
    });
  });
});

// ─── Tests DTO ────────────────────────────────────────────────────────────────

describe('CreateProductSchema — validation DTO', () => {
  it("rejette cost non numérique", () => {
    const r = CreateProductSchema.safeParse({
      code: 'A', name: 'N', cost: 'abc', price: '100', categoryId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(r.success).toBe(false);
    expect(r.error?.flatten().fieldErrors).toHaveProperty('cost');
  });

  it("rejette price négatif", () => {
    const r = CreateProductSchema.safeParse({
      code: 'A', name: 'N', cost: '100', price: '-50', categoryId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(r.success).toBe(false);
    expect(r.error?.flatten().fieldErrors).toHaveProperty('price');
  });

  it("rejette categoryId non-UUID", () => {
    const r = CreateProductSchema.safeParse({
      code: 'A', name: 'N', cost: '100', price: '200', categoryId: 'pas-un-uuid',
    });
    expect(r.success).toBe(false);
    expect(r.error?.flatten().fieldErrors).toHaveProperty('categoryId');
  });

  it("accepte un DTO valide minimal", () => {
    const r = CreateProductSchema.safeParse({
      code: 'REF-001', name: 'Produit', cost: '1000', price: '1500',
      categoryId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(r.success).toBe(true);
  });
});
