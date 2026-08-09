import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import type { PaginatedResult } from '../../common/types';
import type { CreateExpenseDto, UpdateExpenseDto } from './dto/create-expense.dto';

export interface ExpenseResponse {
  id: string;
  organizationId: string;
  date: Date;
  reference: string;
  userId: string;
  expenseCategoryId: string;
  warehouseId: string;
  details: string;
  amount: Decimal;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const EXPENSE_SELECT = {
  id: true,
  organizationId: true,
  date: true,
  reference: true,
  userId: true,
  expenseCategoryId: true,
  warehouseId: true,
  details: true,
  amount: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Service de gestion des dépenses (S29) — CRUD standard, PAS un document commercial avec
 * cycle de vie : aucun statut PENDING/COMPLETED, aucun mouvement de stock, aucun paiement
 * partiel, aucune transaction Serializable ni verrouillage optimiste (contrairement à
 * SaleService). Une dépense est un fait comptable unique et immédiat.
 *
 * Invariants de sécurité :
 *  - organizationId est toujours extrait de req.user, jamais de l'URL ni du body (anti-IDOR).
 *  - expenseCategoryId et warehouseId sont vérifiés appartenir à l'organisation DANS la
 *    transaction de création (anti-IDOR + anti-TOCTOU), mirror léger de
 *    SaleService.verifyClientOwnership/verifyWarehouseOwnership.
 *  - reference générée via DocumentCounterService.nextReference (DocumentType.EXPENSE,
 *    préfixe "DEP") dans la transaction de création — jamais MAX(reference)+1 (§17 point 4).
 *  - amount toujours en Decimal, jamais Float (§17 point A).
 *  - remove : soft delete uniquement (deletedAt = now()), jamais de suppression physique —
 *    une dépense est un montant financier réel (§17 point 7).
 */
@Injectable()
export class ExpenseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
  ) {}

  /**
   * Crée une dépense pour l'organisation dans une transaction Prisma standard (pas
   * Serializable — aucun stock ni verrouillage optimiste en jeu ici). Vérifie l'ownership
   * de expenseCategoryId et warehouseId, génère la référence (DEP-YYYY-NNNNNN), puis crée
   * l'enregistrement.
   *
   * @param organizationId - scopé tenant
   * @param userId         - utilisateur authentifié à l'origine de la dépense (req.user.id)
   * @param dto            - champs validés par CreateExpenseSchema
   * @throws NotFoundException si la catégorie ou l'entrepôt est introuvable/soft-supprimé
   * @throws ForbiddenException si la catégorie ou l'entrepôt n'appartient pas à l'organisation
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateExpenseDto,
  ): Promise<ExpenseResponse> {
    return this.prisma.$transaction(async (tx) => {
      await this.verifyExpenseCategoryOwnership(tx, dto.expenseCategoryId, organizationId);
      await this.verifyWarehouseOwnership(tx, dto.warehouseId, organizationId);

      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.EXPENSE,
      );

      return tx.expense.create({
        data: {
          organizationId,
          date: new Date(dto.date),
          reference,
          userId,
          expenseCategoryId: dto.expenseCategoryId,
          warehouseId: dto.warehouseId,
          details: dto.details,
          amount: new Decimal(dto.amount),
        },
        select: EXPENSE_SELECT,
      });
    });
  }

  /**
   * Retourne la liste paginée des dépenses de l'organisation, filtrable par
   * expenseCategoryId, warehouseId et date.
   * viewAll=false ajoute un filtre WHERE userId = userId (permission records.viewAll,
   * injectée par ViewAllInterceptor) — mirror QuotationService.findAll.
   */
  async findAll(
    organizationId: string,
    userId: string,
    viewAll: boolean,
    page: number,
    limit: number,
    expenseCategoryId?: string,
    warehouseId?: string,
    date?: string,
  ): Promise<PaginatedResult<ExpenseResponse>> {
    const where: Prisma.ExpenseWhereInput = {
      organizationId,
      deletedAt: null,
      ...(viewAll ? {} : { userId }),
      ...(expenseCategoryId ? { expenseCategoryId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(date ? { date: new Date(date) } : {}),
    };

    const skip = (page - 1) * limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.expense.findMany({
        where,
        select: EXPENSE_SELECT,
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Retourne une dépense par id, vérifiée pour l'organisation.
   * Lève 404 si introuvable ou soft-deleted, 403 si appartient à une autre org.
   * Reste consultable même si sa catégorie a été supprimée entre-temps (expenseCategoryId
   * est conservé — cf. ExpenseCategoryService.remove).
   *
   * @param id             - UUID de la dépense
   * @param organizationId - scopé tenant
   */
  async findOne(id: string, organizationId: string): Promise<ExpenseResponse> {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      select: EXPENSE_SELECT,
    });
    if (!expense || expense.deletedAt !== null) {
      throw new NotFoundException(`Dépense introuvable (id: ${id}).`);
    }
    if (expense.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    return expense;
  }

  /**
   * Met à jour une dépense existante. Aucune restriction de statut (il n'y a pas de
   * statut !) — une dépense peut être modifiée à tout moment tant qu'elle n'est pas
   * soft-deleted. Re-vérifie l'ownership de expenseCategoryId/warehouseId si fournis.
   *
   * @param id             - UUID de la dépense
   * @param organizationId - scopé tenant
   * @param dto            - champs à mettre à jour (partiel)
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdateExpenseDto,
  ): Promise<ExpenseResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findUnique({
        where: { id },
        select: { organizationId: true, deletedAt: true },
      });
      if (!existing || existing.deletedAt !== null) {
        throw new NotFoundException(`Dépense introuvable (id: ${id}).`);
      }
      if (existing.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }

      if (dto.expenseCategoryId) {
        await this.verifyExpenseCategoryOwnership(tx, dto.expenseCategoryId, organizationId);
      }
      if (dto.warehouseId) {
        await this.verifyWarehouseOwnership(tx, dto.warehouseId, organizationId);
      }

      return tx.expense.update({
        where: { id },
        data: {
          ...(dto.date !== undefined && { date: new Date(dto.date) }),
          ...(dto.expenseCategoryId !== undefined && { expenseCategoryId: dto.expenseCategoryId }),
          ...(dto.warehouseId !== undefined && { warehouseId: dto.warehouseId }),
          ...(dto.details !== undefined && { details: dto.details }),
          ...(dto.amount !== undefined && { amount: new Decimal(dto.amount) }),
        },
        select: EXPENSE_SELECT,
      });
    });
  }

  /**
   * Soft-delete d'une dépense (deletedAt = now()). Jamais de suppression physique —
   * une dépense est un montant financier réel (§17 point 7).
   *
   * @param id             - UUID de la dépense
   * @param organizationId - scopé tenant
   */
  async remove(id: string, organizationId: string): Promise<void> {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      select: { organizationId: true, deletedAt: true },
    });
    if (!expense || expense.deletedAt !== null) {
      throw new NotFoundException(`Dépense introuvable (id: ${id}).`);
    }
    if (expense.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    await this.prisma.expense.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Vérifie que la catégorie de dépense appartient à l'organisation (anti-IDOR).
   * Note : une catégorie soft-deleted n'est PAS acceptée à la création/modification d'une
   * dépense (seules les dépenses déjà créées conservent leur expenseCategoryId après
   * suppression de la catégorie — cf. ExpenseCategoryService.remove).
   */
  private async verifyExpenseCategoryOwnership(
    tx: Prisma.TransactionClient,
    expenseCategoryId: string,
    organizationId: string,
  ): Promise<void> {
    const category = await tx.expenseCategory.findUnique({
      where: { id: expenseCategoryId },
      select: { organizationId: true, deletedAt: true },
    });
    if (!category || category.deletedAt !== null) {
      throw new NotFoundException('Catégorie de dépense introuvable.');
    }
    if (category.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé à la catégorie de dépense.');
    }
  }

  /**
   * Vérifie que l'entrepôt appartient à l'organisation (anti-IDOR).
   */
  private async verifyWarehouseOwnership(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    organizationId: string,
  ): Promise<void> {
    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      select: { organizationId: true, deletedAt: true },
    });
    if (!warehouse || warehouse.deletedAt !== null) {
      throw new NotFoundException('Entrepôt introuvable.');
    }
    if (warehouse.organizationId !== organizationId) {
      throw new ForbiddenException("Accès refusé à l'entrepôt.");
    }
  }
}
