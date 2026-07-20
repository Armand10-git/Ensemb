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
import type { CreateWarehouseDto, UpdateWarehouseDto } from './dto/warehouse.dto';

export interface WarehouseSummary {
  id: string;
  name: string;
  address: string | null;
  isDefault: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const WAREHOUSE_SELECT = {
  id: true,
  name: true,
  address: true,
  isDefault: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Service de gestion des entrepôts tenant (S09 — Bloc C).
 *
 * Invariants de sécurité :
 *  - organizationId est toujours extrait de req.user, jamais de l'URL (anti-IDOR).
 *  - Chaque requête filtre sur organizationId ET deletedAt IS NULL (soft-delete).
 *  - La contrainte isDefault est gérée transactionnellement (pas de double default).
 *  - La suppression du dernier entrepôt actif est refusée avec un message explicite.
 */
@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne les entrepôts actifs de l'organisation, paginés.
   * Les entrepôts soft-deleted (deletedAt IS NOT NULL) sont toujours exclus.
   *
   * @param organizationId - scopé tenant
   * @param page           - page courante (base 1)
   * @param limit          - taille de page (max 100)
   */
  async findAll(
    organizationId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<WarehouseSummary>> {
    const where = { organizationId, deletedAt: null };
    const [data, total] = await Promise.all([
      this.prisma.warehouse.findMany({
        where,
        select: WAREHOUSE_SELECT,
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.warehouse.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Retourne un entrepôt par id, vérifié pour l'organisation.
   * Lève 404 si introuvable ou soft-deleted.
   * Lève 403 si l'entrepôt appartient à une autre organisation.
   *
   * @param id             - UUID de l'entrepôt
   * @param organizationId - scopé tenant
   */
  async findOne(id: string, organizationId: string): Promise<WarehouseSummary> {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id },
      select: { ...WAREHOUSE_SELECT, organizationId: true, deletedAt: true },
    });
    if (!warehouse || warehouse.deletedAt !== null) {
      throw new NotFoundException(`Entrepôt introuvable (id: ${id}).`);
    }
    if (warehouse.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { organizationId: _oid, deletedAt: _d, ...result } = warehouse;
    return result;
  }

  /**
   * Crée un entrepôt pour l'organisation.
   * Si isDefault est true, retire isDefault de tous les autres entrepôts de l'org
   * dans la même transaction (atomicité garantie).
   *
   * @param organizationId - scopé tenant
   * @param dto            - champs validés par CreateWarehouseSchema
   */
  async create(organizationId: string, dto: CreateWarehouseDto): Promise<WarehouseSummary> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault) {
          await tx.warehouse.updateMany({
            where: { organizationId, deletedAt: null, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.warehouse.create({
          data: {
            organizationId,
            name: dto.name,
            address: dto.address ?? null,
            isDefault: dto.isDefault,
          },
          select: WAREHOUSE_SELECT,
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `Un entrepôt actif nommé "${dto.name}" existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Modifie un entrepôt.
   * Si isDefault passe à true, retire isDefault des autres entrepôts dans la même transaction.
   *
   * @param id             - UUID de l'entrepôt
   * @param organizationId - scopé tenant
   * @param dto            - champs à mettre à jour (partiel)
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdateWarehouseDto,
  ): Promise<WarehouseSummary> {
    await this.findOne(id, organizationId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.warehouse.updateMany({
          where: { organizationId, deletedAt: null, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.warehouse.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        },
        select: WAREHOUSE_SELECT,
      });
    });
  }

  /**
   * Soft-delete d'un entrepôt (deletedAt = now()).
   * Interdit si c'est le seul entrepôt actif de l'organisation.
   *
   * @param id             - UUID de l'entrepôt
   * @param organizationId - scopé tenant
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.findOne(id, organizationId);

    const activeCount = await this.prisma.warehouse.count({
      where: { organizationId, deletedAt: null },
    });
    if (activeCount <= 1) {
      throw new BadRequestException(
        "Impossible de supprimer le seul entrepôt actif de l'organisation. Créez-en un autre avant de supprimer celui-ci.",
      );
    }

    await this.prisma.warehouse.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
