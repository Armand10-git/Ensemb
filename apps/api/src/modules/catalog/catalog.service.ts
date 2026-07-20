import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { PaginatedResult } from '../../common/types';
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/create-category.dto';

export interface CategorySummary {
  id: string;
  code: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const CATEGORY_SELECT = {
  id: true,
  code: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Service de gestion des catégories de produits tenant (S10 — Bloc C).
 *
 * Invariants de sécurité :
 *  - organizationId est toujours extrait de req.user, jamais de l'URL (anti-IDOR).
 *  - Chaque requête filtre sur organizationId ET deletedAt IS NULL.
 *  - P2002 (doublon code ou name) → ConflictException avec message explicite en français.
 *  - remove interdit si des produits actifs sont rattachés à la catégorie.
 */
@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne les catégories actives de l'organisation, paginées et triées par nom.
   *
   * @param organizationId - scopé tenant
   * @param page           - page courante (base 1)
   * @param limit          - taille de page (max 100)
   */
  async findAll(
    organizationId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<CategorySummary>> {
    const where = { organizationId, deletedAt: null };
    const [data, total] = await Promise.all([
      this.prisma.category.findMany({
        where,
        select: CATEGORY_SELECT,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.category.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Retourne une catégorie par id, vérifiée pour l'organisation.
   * Lève 404 si introuvable ou soft-deleted, 403 si appartient à une autre org.
   *
   * @param id             - UUID de la catégorie
   * @param organizationId - scopé tenant
   */
  async findOne(id: string, organizationId: string): Promise<CategorySummary> {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: { ...CATEGORY_SELECT, organizationId: true, deletedAt: true },
    });
    if (!category || category.deletedAt !== null) {
      throw new NotFoundException(`Catégorie introuvable (id: ${id}).`);
    }
    if (category.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { organizationId: _oid, deletedAt: _d, ...result } = category;
    return result;
  }

  /**
   * Crée une catégorie pour l'organisation.
   * P2002 (code ou name en doublon actif) → ConflictException avec champ identifié.
   *
   * @param organizationId - scopé tenant
   * @param dto            - champs validés par CreateCategorySchema
   */
  async create(organizationId: string, dto: CreateCategoryDto): Promise<CategorySummary> {
    try {
      return await this.prisma.category.create({
        data: { organizationId, code: dto.code, name: dto.name },
        select: CATEGORY_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const targets = (err.meta?.target as string[] | undefined) ?? [];
        const field = targets.some((t) => t.includes('code')) ? 'code' : 'nom';
        throw new ConflictException(
          `Une catégorie active avec ce ${field} existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Modifie une catégorie existante.
   * Vérifie l'ownership avant modification ; P2002 → ConflictException.
   *
   * @param id             - UUID de la catégorie
   * @param organizationId - scopé tenant
   * @param dto            - champs à mettre à jour (partiel)
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdateCategoryDto,
  ): Promise<CategorySummary> {
    await this.findOne(id, organizationId);
    try {
      return await this.prisma.category.update({
        where: { id },
        data: {
          ...(dto.code !== undefined && { code: dto.code }),
          ...(dto.name !== undefined && { name: dto.name }),
        },
        select: CATEGORY_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const targets = (err.meta?.target as string[] | undefined) ?? [];
        const field = targets.some((t) => t.includes('code')) ? 'code' : 'nom';
        throw new ConflictException(
          `Une catégorie active avec ce ${field} existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Soft-delete d'une catégorie (deletedAt = now()).
   * Interdit si des produits actifs sont rattachés à cette catégorie.
   *
   * @param id             - UUID de la catégorie
   * @param organizationId - scopé tenant
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.findOne(id, organizationId);

    const activeProductCount = await this.prisma.product.count({
      where: { categoryId: id, deletedAt: null },
    });
    if (activeProductCount > 0) {
      throw new BadRequestException(
        `Impossible de supprimer cette catégorie : ${activeProductCount} produit(s) actif(s) y sont rattaché(s). Reassignez-les d'abord.`,
      );
    }

    await this.prisma.category.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
