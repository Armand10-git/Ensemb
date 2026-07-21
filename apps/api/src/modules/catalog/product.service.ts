import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import type { PaginatedResult } from '../../common/types';
import type { CreateProductDto, UpdateProductDto, CreateProductVariantDto } from './dto/create-product.dto';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface ProductVariantSummary {
  id: string;
  name: string | null;
  deletedAt: Date | null;
}

export interface ProductSummary {
  id: string;
  code: string;
  barcodeType: string | null;
  name: string;
  cost: Decimal;
  price: Decimal;
  taxRate: Decimal;
  taxMethod: string;
  image: string | null;
  /** URL signée générée à la volée — jamais persistée (§17 point Y). */
  imageUrl: string | null;
  note: string | null;
  stockAlert: number;
  isVariant: boolean;
  isActive: boolean;
  categoryId: string;
  brandId: string | null;
  unitId: string | null;
  unitSaleId: string | null;
  unitPurchaseId: string | null;
  category: { id: string; code: string; name: string };
  brand: { id: string; name: string } | null;
  unit: { id: string; name: string; shortName: string } | null;
  unitSale: { id: string; name: string; shortName: string } | null;
  unitPurchase: { id: string; name: string; shortName: string } | null;
  variants: ProductVariantSummary[];
  createdAt: Date;
  updatedAt: Date;
}

const PRODUCT_SELECT = {
  id: true,
  code: true,
  barcodeType: true,
  name: true,
  cost: true,
  price: true,
  taxRate: true,
  taxMethod: true,
  image: true,
  note: true,
  stockAlert: true,
  isVariant: true,
  isActive: true,
  categoryId: true,
  brandId: true,
  unitId: true,
  unitSaleId: true,
  unitPurchaseId: true,
  category: { select: { id: true, code: true, name: true } },
  brand:    { select: { id: true, name: true } },
  unit:     { select: { id: true, name: true, shortName: true } },
  unitSale: { select: { id: true, name: true, shortName: true } },
  unitPurchase: { select: { id: true, name: true, shortName: true } },
  variants: {
    select: { id: true, name: true, deletedAt: true },
    where: { deletedAt: null },
    orderBy: { name: 'asc' as const },
  },
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Service de gestion du catalogue produits (S14 — Bloc D).
 *
 * Invariants de sécurité :
 *  - organizationId toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *  - Chaque FK reçue (categoryId, brandId, unitId…) est vérifiée dans l'org du token.
 *  - image : clé S3 en base — URL signée générée à la volée, jamais persistée (§17 point Y).
 *  - La clé S3 brute n'est jamais exposée dans les réponses HTTP.
 *  - cost / price / taxRate : Decimal — jamais Float (§17 point A).
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
  ) {}

  // ── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Génère l'URL signée depuis la clé S3 et retourne le produit sans exposer la clé brute.
   * imageUrl est null si aucune image n'est associée.
   */
  private async withImageUrl<T extends { image: string | null }>(
    product: T,
  ): Promise<T & { imageUrl: string | null }> {
    const imageUrl = product.image ? await this.uploads.getSignedUrl(product.image) : null;
    return { ...product, imageUrl };
  }

  private async withImageUrls<T extends { image: string | null }>(
    products: T[],
  ): Promise<(T & { imageUrl: string | null })[]> {
    return Promise.all(products.map((p) => this.withImageUrl(p)));
  }

  /**
   * Vérifie qu'une entité optionnelle (brandId, unitId…) appartient à l'organisation.
   * Lève ForbiddenException si l'entité existe mais n'appartient pas à l'org.
   * Lève NotFoundException si l'entité n'existe pas du tout.
   */
  private async checkFkOwnership(
    entityType: 'category' | 'brand' | 'unit',
    id: string,
    organizationId: string,
  ): Promise<void> {
    // any justifié : Prisma génère des types distincts par modèle mais la structure
    // { organizationId, deletedAt } est commune — le cast évite la duplication de code.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = this.prisma[entityType] as unknown as { findUnique: (args: any) => Promise<{ organizationId: string; deletedAt: Date | null } | null> };
    const row = await delegate.findUnique({
      where: { id },
      select: { organizationId: true, deletedAt: true },
    });
    if (!row || row.deletedAt !== null) {
      throw new NotFoundException(`${entityType} introuvable (id: ${id}).`);
    }
    if (row.organizationId !== organizationId) {
      throw new ForbiddenException(`Accès refusé : ${entityType} (id: ${id}) n'appartient pas à cette organisation.`);
    }
  }

  /**
   * Valide toutes les FK optionnelles d'un DTO produit.
   * categoryId est obligatoire et doit appartenir à l'org.
   */
  private async validateFks(
    dto: Pick<CreateProductDto, 'categoryId' | 'brandId' | 'unitId' | 'unitSaleId' | 'unitPurchaseId'>,
    organizationId: string,
  ): Promise<void> {
    await this.checkFkOwnership('category', dto.categoryId, organizationId);
    if (dto.brandId)        await this.checkFkOwnership('brand', dto.brandId, organizationId);
    if (dto.unitId)         await this.checkFkOwnership('unit', dto.unitId, organizationId);
    if (dto.unitSaleId)     await this.checkFkOwnership('unit', dto.unitSaleId, organizationId);
    if (dto.unitPurchaseId) await this.checkFkOwnership('unit', dto.unitPurchaseId, organizationId);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  /**
   * Retourne les produits actifs de l'organisation, paginés, filtrés et enrichis d'URL signée.
   *
   * @param organizationId - scope tenant
   * @param page           - page courante (base 1)
   * @param limit          - taille de page (max 100)
   * @param search         - recherche sur code ou nom (optionnel)
   * @param categoryId     - filtre par catégorie (optionnel)
   * @param brandId        - filtre par marque (optionnel)
   */
  async findAll(
    organizationId: string,
    page: number,
    limit: number,
    search?: string,
    categoryId?: string,
    brandId?: string,
  ): Promise<PaginatedResult<ProductSummary>> {
    const where: Prisma.ProductWhereInput = {
      organizationId,
      deletedAt: null,
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { code: { contains: search, mode: 'insensitive' } },
        ],
      }),
      ...(categoryId && { categoryId }),
      ...(brandId && { brandId }),
    };

    const [rawData, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: PRODUCT_SELECT,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    const data = await this.withImageUrls(rawData as unknown as (typeof rawData[number] & { image: string | null })[]);
    return { data: data as unknown as ProductSummary[], total, page, limit };
  }

  /**
   * Retourne un produit par id, vérifié pour l'organisation, avec URL signée.
   *
   * @param id             - UUID du produit
   * @param organizationId - scope tenant
   */
  async findOne(id: string, organizationId: string): Promise<ProductSummary> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: { ...PRODUCT_SELECT, organizationId: true, deletedAt: true },
    });
    if (!product || product.deletedAt !== null) {
      throw new NotFoundException(`Produit introuvable (id: ${id}).`);
    }
    if (product.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { organizationId: _oid, deletedAt: _d, ...rest } = product;
    return this.withImageUrl(rest as unknown as ProductSummary & { image: string | null });
  }

  /**
   * Crée un produit pour l'organisation, avec ses variantes initiales le cas échéant.
   * Toutes les FK optionnelles sont vérifiées pour l'IDOR avant insertion.
   * La création du produit + variantes se fait dans une transaction Prisma.
   *
   * @param organizationId - scope tenant
   * @param dto            - champs validés par CreateProductSchema
   */
  async create(organizationId: string, dto: CreateProductDto): Promise<ProductSummary> {
    await this.validateFks(dto, organizationId);

    try {
      const product = await this.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            organizationId,
            code: dto.code,
            barcodeType: dto.barcodeType ?? null,
            name: dto.name,
            cost: new Decimal(dto.cost),
            price: new Decimal(dto.price),
            categoryId: dto.categoryId,
            brandId: dto.brandId ?? null,
            unitId: dto.unitId ?? null,
            unitSaleId: dto.unitSaleId ?? null,
            unitPurchaseId: dto.unitPurchaseId ?? null,
            taxRate: dto.taxRate ? new Decimal(dto.taxRate) : new Decimal(0),
            taxMethod: dto.taxMethod ?? 'percentage',
            note: dto.note ?? null,
            stockAlert: dto.stockAlert ?? 0,
            isVariant: dto.isVariant ?? false,
          },
          select: PRODUCT_SELECT,
        });

        if (dto.isVariant && dto.variants && dto.variants.length > 0) {
          await tx.productVariant.createMany({
            data: dto.variants.map((v) => ({
              productId: created.id,
              name: v.name ?? null,
            })),
          });
          return tx.product.findUniqueOrThrow({
            where: { id: created.id },
            select: PRODUCT_SELECT,
          });
        }

        return created;
      });

      return this.withImageUrl(product as unknown as ProductSummary & { image: string | null });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const targets = (err.meta?.target as string[] | undefined) ?? [];
        if (targets.some((t) => t.includes('code'))) {
          throw new ConflictException(
            `Un produit avec le code "${dto.code}" existe déjà dans cette organisation.`,
          );
        }
        throw new ConflictException('Contrainte d\'unicité violée.');
      }
      throw err;
    }
  }

  /**
   * Modifie un produit existant.
   * Vérifie l'ownership et les FK IDOR avant mise à jour.
   *
   * @param id             - UUID du produit
   * @param organizationId - scope tenant
   * @param dto            - champs à mettre à jour (partiel)
   */
  async update(id: string, organizationId: string, dto: UpdateProductDto): Promise<ProductSummary> {
    await this.findOne(id, organizationId);

    if (dto.categoryId)      await this.checkFkOwnership('category', dto.categoryId, organizationId);
    if (dto.brandId)         await this.checkFkOwnership('brand', dto.brandId, organizationId);
    if (dto.unitId)          await this.checkFkOwnership('unit', dto.unitId, organizationId);
    if (dto.unitSaleId)      await this.checkFkOwnership('unit', dto.unitSaleId, organizationId);
    if (dto.unitPurchaseId)  await this.checkFkOwnership('unit', dto.unitPurchaseId, organizationId);

    try {
      const updated = await this.prisma.product.update({
        where: { id },
        data: {
          ...(dto.code !== undefined && { code: dto.code }),
          ...(dto.barcodeType !== undefined && { barcodeType: dto.barcodeType }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.cost !== undefined && { cost: new Decimal(dto.cost) }),
          ...(dto.price !== undefined && { price: new Decimal(dto.price) }),
          ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
          ...(dto.brandId !== undefined && { brandId: dto.brandId }),
          ...(dto.unitId !== undefined && { unitId: dto.unitId }),
          ...(dto.unitSaleId !== undefined && { unitSaleId: dto.unitSaleId }),
          ...(dto.unitPurchaseId !== undefined && { unitPurchaseId: dto.unitPurchaseId }),
          ...(dto.taxRate !== undefined && { taxRate: new Decimal(dto.taxRate) }),
          ...(dto.taxMethod !== undefined && { taxMethod: dto.taxMethod }),
          ...(dto.note !== undefined && { note: dto.note }),
          ...(dto.stockAlert !== undefined && { stockAlert: dto.stockAlert }),
          ...(dto.isVariant !== undefined && { isVariant: dto.isVariant }),
        },
        select: PRODUCT_SELECT,
      });
      return this.withImageUrl(updated as unknown as ProductSummary & { image: string | null });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `Un produit avec ce code existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Upload et associe une image au produit.
   * Supprime l'ancienne clé S3 si une image existait déjà.
   * Retourne l'URL signée — jamais la clé S3 brute (§17 point Y).
   *
   * @param id             - UUID du produit
   * @param organizationId - scope tenant
   * @param file           - fichier reçu de multer (memoryStorage)
   */
  async uploadImage(
    id: string,
    organizationId: string,
    file: Express.Multer.File,
  ): Promise<{ imageUrl: string }> {
    const product = await this.findOne(id, organizationId);
    const oldKey = product.image;

    const newKey = await this.uploads.uploadImage(organizationId, 'products', file);

    await this.prisma.product.update({
      where: { id },
      data: { image: newKey },
    });

    if (oldKey) {
      await this.uploads.deleteImage(oldKey);
    }

    const imageUrl = await this.uploads.getSignedUrl(newKey);
    return { imageUrl };
  }

  /**
   * Soft-delete du produit et de toutes ses variantes actives.
   * Les clés S3 sont conservées (soft-delete ≠ purge physique — suppression S3 en purge hors S14).
   *
   * @param id             - UUID du produit
   * @param organizationId - scope tenant
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.findOne(id, organizationId);

    // TODO S19: vérifier ProductWarehouse avant suppression si stock non nul
    await this.prisma.$transaction([
      this.prisma.productVariant.updateMany({
        where: { productId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      }),
      this.prisma.product.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    ]);
  }

  // ── Variantes ───────────────────────────────────────────────────────────────

  /**
   * Ajoute une variante à un produit existant.
   *
   * @param productId      - UUID du produit parent
   * @param organizationId - scope tenant
   * @param dto            - données de la variante
   */
  async createVariant(
    productId: string,
    organizationId: string,
    dto: CreateProductVariantDto,
  ): Promise<ProductVariantSummary> {
    const product = await this.findOne(productId, organizationId);
    if (!product.isVariant) {
      throw new ConflictException('Ce produit n\'est pas configuré pour avoir des variantes (isVariant = false).');
    }
    return this.prisma.productVariant.create({
      data: {
        productId,
        name: dto.name ?? null,
      },
      select: { id: true, name: true, deletedAt: true },
    });
  }

  /**
   * Soft-delete d'une variante.
   *
   * @param productId      - UUID du produit parent
   * @param variantId      - UUID de la variante
   * @param organizationId - scope tenant
   */
  async removeVariant(
    productId: string,
    variantId: string,
    organizationId: string,
  ): Promise<void> {
    await this.findOne(productId, organizationId);

    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { productId: true, deletedAt: true },
    });
    if (!variant || variant.deletedAt !== null) {
      throw new NotFoundException(`Variante introuvable (id: ${variantId}).`);
    }
    if (variant.productId !== productId) {
      throw new ForbiddenException('Cette variante n\'appartient pas à ce produit.');
    }
    await this.prisma.productVariant.update({
      where: { id: variantId },
      data: { deletedAt: new Date() },
    });
  }
}
