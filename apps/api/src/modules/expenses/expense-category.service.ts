import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { PaginatedResult } from '../../common/types';
import type {
  CreateExpenseCategoryDto,
  UpdateExpenseCategoryDto,
} from './dto/create-expense-category.dto';

export interface ExpenseCategorySummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const EXPENSE_CATEGORY_SELECT = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Service de gestion des catégories de dépenses tenant (S29).
 *
 * Donnée de référence simple — mirror quasi-identique de BrandService (S10) :
 *  - organizationId est toujours extrait de req.user, jamais de l'URL (anti-IDOR).
 *  - Chaque requête filtre sur organizationId ET deletedAt IS NULL.
 *  - P2002 (name en doublon actif) → ConflictException avec message explicite en français.
 *  - remove : toujours permis — les Expense.expenseCategoryId existants sont conservés
 *    (une dépense reste consultable avec son expenseCategoryId même si la catégorie a été
 *    supprimée ; aucune vérification bloquante « catégorie encore utilisée »).
 */
@Injectable()
export class ExpenseCategoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne les catégories de dépenses actives de l'organisation, paginées et triées par nom.
   *
   * @param organizationId - scopé tenant
   * @param page           - page courante (base 1)
   * @param limit          - taille de page (max 100)
   */
  async findAll(
    organizationId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<ExpenseCategorySummary>> {
    const where = { organizationId, deletedAt: null };
    const [data, total] = await Promise.all([
      this.prisma.expenseCategory.findMany({
        where,
        select: EXPENSE_CATEGORY_SELECT,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.expenseCategory.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Retourne une catégorie de dépense par id, vérifiée pour l'organisation.
   * Lève 404 si introuvable ou soft-deleted, 403 si appartient à une autre org.
   *
   * @param id             - UUID de la catégorie
   * @param organizationId - scopé tenant
   */
  async findOne(id: string, organizationId: string): Promise<ExpenseCategorySummary> {
    const category = await this.prisma.expenseCategory.findUnique({
      where: { id },
      select: { ...EXPENSE_CATEGORY_SELECT, organizationId: true, deletedAt: true },
    });
    if (!category || category.deletedAt !== null) {
      throw new NotFoundException(`Catégorie de dépense introuvable (id: ${id}).`);
    }
    if (category.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { organizationId: _oid, deletedAt: _d, ...result } = category;
    return result;
  }

  /**
   * Crée une catégorie de dépense pour l'organisation.
   * P2002 (name en doublon actif) → ConflictException avec message explicite.
   *
   * @param organizationId - scopé tenant
   * @param userId         - utilisateur authentifié à l'origine de la création (req.user.id)
   * @param dto            - champs validés par CreateExpenseCategorySchema
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateExpenseCategoryDto,
  ): Promise<ExpenseCategorySummary> {
    try {
      return await this.prisma.expenseCategory.create({
        data: {
          organizationId,
          userId,
          name: dto.name,
          description: dto.description ?? null,
        },
        select: EXPENSE_CATEGORY_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `Une catégorie de dépense active nommée "${dto.name}" existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Modifie une catégorie de dépense existante.
   * Vérifie l'ownership avant modification ; P2002 → ConflictException.
   *
   * @param id             - UUID de la catégorie
   * @param organizationId - scopé tenant
   * @param dto            - champs à mettre à jour (partiel)
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategorySummary> {
    await this.findOne(id, organizationId);
    try {
      return await this.prisma.expenseCategory.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
        },
        select: EXPENSE_CATEGORY_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `Une catégorie de dépense active avec ce nom existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Soft-delete d'une catégorie de dépense (deletedAt = now()).
   * Toujours permis — les Expense.expenseCategoryId existants sont conservés, une dépense
   * déjà créée reste consultable avec son libellé de catégorie même après cette suppression.
   *
   * @param id             - UUID de la catégorie
   * @param organizationId - scopé tenant
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.findOne(id, organizationId);
    await this.prisma.expenseCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
