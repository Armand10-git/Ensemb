import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../common/prisma.service';
import type { PaginatedResult } from '../../common/types';
import type { CreateUnitDto, UpdateUnitDto } from './dto/create-unit.dto';

export interface BaseUnitSummary {
  id: string;
  name: string;
  shortName: string;
}

export interface UnitSummary {
  id: string;
  name: string;
  shortName: string;
  baseUnitId: string | null;
  baseUnit: BaseUnitSummary | null;
  operator: string;
  operatorValue: Decimal;
  createdAt: Date;
  updatedAt: Date;
}

const UNIT_SELECT = {
  id: true,
  name: true,
  shortName: true,
  baseUnitId: true,
  baseUnit: { select: { id: true, name: true, shortName: true } },
  operator: true,
  operatorValue: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Service de gestion des unités de mesure tenant (S11 — Bloc C).
 *
 * Invariants de sécurité :
 *  - organizationId extrait de req.user — jamais de l'URL (anti-IDOR).
 *  - Chaque requête filtre sur organizationId ET deletedAt IS NULL.
 *  - Hiérarchie max 1 niveau : une unité dérivée ne peut référencer qu'une unité de base.
 *  - P2002 (doublon name ou shortName) → ConflictException avec champ identifié.
 *  - remove interdit si sous-unités actives ou produits actifs rattachés.
 */
@Injectable()
export class UnitService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne les unités actives de l'organisation, paginées et triées par nom.
   *
   * @param organizationId - Scope tenant
   * @param page           - Page courante (base 1)
   * @param limit          - Taille de page (max 100)
   */
  async findAll(
    organizationId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<UnitSummary>> {
    const where = { organizationId, deletedAt: null };
    const [data, total] = await Promise.all([
      this.prisma.unit.findMany({
        where,
        select: UNIT_SELECT,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.unit.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Retourne une unité par id, vérifiée pour l'organisation.
   * Lève 404 si introuvable ou soft-deleted, 403 si appartient à une autre org.
   *
   * @param id             - UUID de l'unité
   * @param organizationId - Scope tenant
   */
  async findOne(id: string, organizationId: string): Promise<UnitSummary> {
    const unit = await this.prisma.unit.findUnique({
      where: { id },
      select: { ...UNIT_SELECT, organizationId: true, deletedAt: true },
    });
    if (!unit || unit.deletedAt !== null) {
      throw new NotFoundException(`Unité introuvable (id: ${id}).`);
    }
    if (unit.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { organizationId: _oid, deletedAt: _d, ...result } = unit;
    return result;
  }

  /**
   * Crée une unité pour l'organisation.
   *
   * Gardes :
   *  - Si baseUnitId fourni : la parente doit appartenir à l'org ET être elle-même une unité de base
   *    (baseUnitId null) — hiérarchie max 1 niveau.
   *  - Si baseUnitId absent : l'unité est une base (operator/operatorValue ignorés → valeurs par défaut).
   *  - P2002 (doublon name ou shortName actif) → ConflictException explicite.
   *
   * @param organizationId - Scope tenant
   * @param dto            - Champs validés par CreateUnitSchema
   */
  async create(organizationId: string, dto: CreateUnitDto): Promise<UnitSummary> {
    let operator = '*';
    let operatorValue = new Decimal('1');

    if (dto.baseUnitId) {
      const parent = await this.prisma.unit.findUnique({
        where: { id: dto.baseUnitId },
        select: { organizationId: true, baseUnitId: true, deletedAt: true },
      });
      if (!parent || parent.deletedAt !== null || parent.organizationId !== organizationId) {
        throw new BadRequestException(
          "L'unité de base spécifiée est introuvable ou n'appartient pas à cette organisation.",
        );
      }
      if (parent.baseUnitId !== null) {
        throw new BadRequestException(
          "L'unité de base spécifiée est elle-même une unité dérivée. La hiérarchie est limitée à 1 niveau.",
        );
      }
      operator = dto.operator ?? '*';
      operatorValue = new Decimal(dto.operatorValue ?? '1');
    }

    try {
      return await this.prisma.unit.create({
        data: {
          organizationId,
          name: dto.name,
          shortName: dto.shortName,
          baseUnitId: dto.baseUnitId ?? null,
          operator,
          operatorValue,
        },
        select: UNIT_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const targets = (err.meta?.target as string[] | undefined) ?? [];
        const field = targets.some((t) => t.includes('shortName') || t.includes('short_name'))
          ? 'nom court'
          : 'nom';
        throw new ConflictException(
          `Une unité active avec ce ${field} existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Modifie une unité existante.
   *
   * Gardes :
   *  - Interdit de changer baseUnitId si l'unité a des sous-unités actives.
   *  - Si un nouveau baseUnitId est fourni : même garde de profondeur que create.
   *  - P2002 → ConflictException explicite.
   *
   * @param id             - UUID de l'unité
   * @param organizationId - Scope tenant
   * @param dto            - Champs à mettre à jour (partiel)
   */
  async update(id: string, organizationId: string, dto: UpdateUnitDto): Promise<UnitSummary> {
    const existing = await this.findOne(id, organizationId);

    if (dto.baseUnitId !== undefined) {
      const activeSubCount = await this.prisma.unit.count({
        where: { baseUnitId: id, deletedAt: null },
      });
      if (activeSubCount > 0) {
        throw new BadRequestException(
          `Impossible de modifier l'unité de base : ${activeSubCount} unité(s) dérivée(s) active(s) en dépendent.`,
        );
      }

      if (dto.baseUnitId !== null) {
        const parent = await this.prisma.unit.findUnique({
          where: { id: dto.baseUnitId },
          select: { organizationId: true, baseUnitId: true, deletedAt: true },
        });
        if (!parent || parent.deletedAt !== null || parent.organizationId !== organizationId) {
          throw new BadRequestException(
            "L'unité de base spécifiée est introuvable ou n'appartient pas à cette organisation.",
          );
        }
        if (parent.baseUnitId !== null) {
          throw new BadRequestException(
            "L'unité de base spécifiée est elle-même une unité dérivée. La hiérarchie est limitée à 1 niveau.",
          );
        }
      }
    }

    // Silence unused variable warning from findOne result
    void existing;

    try {
      return await this.prisma.unit.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.shortName !== undefined && { shortName: dto.shortName }),
          ...(dto.baseUnitId !== undefined && { baseUnitId: dto.baseUnitId }),
          ...(dto.operator !== undefined && { operator: dto.operator }),
          ...(dto.operatorValue !== undefined && {
            operatorValue: new Decimal(dto.operatorValue),
          }),
        },
        select: UNIT_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const targets = (err.meta?.target as string[] | undefined) ?? [];
        const field = targets.some((t) => t.includes('shortName') || t.includes('short_name'))
          ? 'nom court'
          : 'nom';
        throw new ConflictException(
          `Une unité active avec ce ${field} existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Soft-delete d'une unité (deletedAt = now()).
   *
   * Interdit si :
   *  - L'unité a des sous-unités actives.
   *  - Des produits actifs utilisent cette unité (stub — vérification complète en S14).
   *
   * @param id             - UUID de l'unité
   * @param organizationId - Scope tenant
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.findOne(id, organizationId);

    const activeSubCount = await this.prisma.unit.count({
      where: { baseUnitId: id, deletedAt: null },
    });
    if (activeSubCount > 0) {
      throw new BadRequestException(
        `Impossible de supprimer cette unité : ${activeSubCount} unité(s) dérivée(s) active(s) en dépendent. Supprimez-les d'abord.`,
      );
    }

    // TODO S14: vérifier Product.unitId / unitSaleId / unitPurchaseId lorsque les colonnes métier seront ajoutées
    const activeProductCount = await this.prisma.product.count({
      where: {
        deletedAt: null,
        OR: [{ unitId: id }, { unitSaleId: id }, { unitPurchaseId: id }],
      },
    });
    if (activeProductCount > 0) {
      throw new BadRequestException(
        `Impossible de supprimer cette unité : ${activeProductCount} produit(s) actif(s) l'utilisent. Réassignez-les d'abord.`,
      );
    }

    await this.prisma.unit.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
