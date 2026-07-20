import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { PaginatedResult } from '../../common/types';
import type { CreateBrandDto, UpdateBrandDto } from './dto/create-brand.dto';

export interface BrandSummary {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const BRAND_SELECT = {
  id: true,
  name: true,
  description: true,
  image: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Service de gestion des marques de produits tenant (S10 — Bloc C).
 *
 * Invariants de sécurité :
 *  - organizationId est toujours extrait de req.user, jamais de l'URL (anti-IDOR).
 *  - Chaque requête filtre sur organizationId ET deletedAt IS NULL.
 *  - P2002 (name en doublon actif) → ConflictException avec message explicite en français.
 *  - remove : toujours permis (les Product.brandId sont conservés, gérés en S14).
 */
@Injectable()
export class BrandService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne les marques actives de l'organisation, paginées et triées par nom.
   *
   * @param organizationId - scopé tenant
   * @param page           - page courante (base 1)
   * @param limit          - taille de page (max 100)
   */
  async findAll(
    organizationId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<BrandSummary>> {
    const where = { organizationId, deletedAt: null };
    const [data, total] = await Promise.all([
      this.prisma.brand.findMany({
        where,
        select: BRAND_SELECT,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.brand.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Retourne une marque par id, vérifiée pour l'organisation.
   * Lève 404 si introuvable ou soft-deleted, 403 si appartient à une autre org.
   *
   * @param id             - UUID de la marque
   * @param organizationId - scopé tenant
   */
  async findOne(id: string, organizationId: string): Promise<BrandSummary> {
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      select: { ...BRAND_SELECT, organizationId: true, deletedAt: true },
    });
    if (!brand || brand.deletedAt !== null) {
      throw new NotFoundException(`Marque introuvable (id: ${id}).`);
    }
    if (brand.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { organizationId: _oid, deletedAt: _d, ...result } = brand;
    return result;
  }

  /**
   * Crée une marque pour l'organisation.
   * P2002 (name en doublon actif) → ConflictException avec message explicite.
   *
   * @param organizationId - scopé tenant
   * @param dto            - champs validés par CreateBrandSchema
   */
  async create(organizationId: string, dto: CreateBrandDto): Promise<BrandSummary> {
    try {
      return await this.prisma.brand.create({
        data: {
          organizationId,
          name: dto.name,
          description: dto.description ?? null,
          image: dto.image ?? null,
        },
        select: BRAND_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `Une marque active nommée "${dto.name}" existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Modifie une marque existante.
   * Vérifie l'ownership avant modification ; P2002 → ConflictException.
   *
   * @param id             - UUID de la marque
   * @param organizationId - scopé tenant
   * @param dto            - champs à mettre à jour (partiel)
   */
  async update(id: string, organizationId: string, dto: UpdateBrandDto): Promise<BrandSummary> {
    await this.findOne(id, organizationId);
    try {
      return await this.prisma.brand.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.image !== undefined && { image: dto.image }),
        },
        select: BRAND_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `Une marque active avec ce nom existe déjà dans cette organisation.`,
        );
      }
      throw err;
    }
  }

  /**
   * Soft-delete d'une marque (deletedAt = now()).
   * Toujours permis — les Product.brandId sont conservés (gérés en S14).
   *
   * @param id             - UUID de la marque
   * @param organizationId - scopé tenant
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.findOne(id, organizationId);
    await this.prisma.brand.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
