import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import type { Prisma } from '@prisma/client';

export type ActorType = 'USER' | 'PLATFORM_ADMIN' | 'SYSTEM';

export interface CreateAuditLogDto {
  organizationId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

export interface PaginationParams {
  page: number;
  limit: number;
}

type PrismaModel = {
  findUnique: (args: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
};

/**
 * Persiste et expose le journal d'audit des mutations sensibles.
 * La création est non-bloquante : les erreurs sont loggées côté serveur
 * sans jamais remonter au client.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lit l'état courant d'une entité avant mutation (pour le champ `before`).
   * Retourne null si le modèle Prisma n'existe pas ou si la lecture échoue.
   *
   * @param entity - Nom du modèle Prisma (ex. "Role").
   * @param id - UUID de l'entité.
   */
  async fetchEntitySnapshot(entity: string, id: string): Promise<Record<string, unknown> | null> {
    const modelKey = entity.charAt(0).toLowerCase() + entity.slice(1);
    const model = (this.prisma as unknown as Record<string, PrismaModel | undefined>)[modelKey];
    if (!model) return null;
    try {
      return await model.findUnique({ where: { id } });
    } catch {
      return null;
    }
  }

  /**
   * Crée une entrée AuditLog.
   * Ne lève jamais d'exception — un échec d'audit ne doit jamais faire échouer
   * la requête principale.
   */
  async create(dto: CreateAuditLogDto): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          organizationId: dto.organizationId ?? null,
          actorType: dto.actorType,
          actorId: dto.actorId ?? null,
          action: dto.action,
          entity: dto.entity,
          entityId: dto.entityId ?? null,
          before: dto.before ?? undefined,
          after: dto.after ?? undefined,
        },
      });
    } catch (err: unknown) {
      this.logger.error('Echec de persistence AuditLog', err);
    }
  }

  /**
   * Liste les entrées d'audit d'une organisation, paginées par date décroissante.
   *
   * @param organizationId - Identifiant du tenant.
   * @param pagination - Numéro de page (1-based) et taille de page.
   */
  async findAll(organizationId: string, pagination: PaginationParams) {
    const { page, limit } = pagination;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where: { organizationId } }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
