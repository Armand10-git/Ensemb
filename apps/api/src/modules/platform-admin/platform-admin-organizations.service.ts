import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';

/** TTL de la clé de suspension en Redis = durée max du refresh token tenant (7 jours). */
const ORG_SUSPENDED_TTL_S = 7 * 24 * 60 * 60;

export interface OrgSummary {
  id: string;
  name: string;
  subdomain: string;
  status: string;
  plan: string | null;
  subscriptionStatus: string | null;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

/**
 * Gestion des organisations depuis la console plateforme.
 *
 * suspend/reactivate utilisent une `$transaction` Prisma pour garantir
 * l'atomicité entre la mise à jour du statut et la trace d'audit.
 * Redis est posé/supprimé après la transaction (Redis ne peut pas participer
 * à une transaction Postgres).
 */
@Injectable()
export class PlatformAdminOrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Liste paginée des organisations avec leur statut d'abonnement et plan.
   * Ne retourne jamais de données sensibles (totpSecret, mot de passe, etc.).
   */
  async listOrganizations(page: number, limit: number): Promise<PaginatedResult<OrgSummary>> {
    const skip = (page - 1) * limit;

    const [organizations, total] = await Promise.all([
      this.prisma.organization.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          subdomain: true,
          status: true,
          createdAt: true,
          subscription: {
            select: {
              status: true,
              plan: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.organization.count({ where: { deletedAt: null } }),
    ]);

    const data: OrgSummary[] = organizations.map((org) => ({
      id: org.id,
      name: org.name,
      subdomain: org.subdomain,
      status: org.status,
      plan: org.subscription?.plan.name ?? null,
      subscriptionStatus: org.subscription?.status ?? null,
      createdAt: org.createdAt,
    }));

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Suspend une organisation (idempotent si déjà suspendue).
   *
   * Actions atomiques (Prisma $transaction) :
   * 1. Organization.status → SUSPENDED
   * 2. AuditLog créé
   * Puis (hors transaction) :
   * 3. Clé Redis platform:org-suspended:<orgId> posée (TTL 7j) — bloque tous les refresh
   *
   * @param orgId   - UUID de l'organisation à suspendre
   * @param actorId - UUID du PlatformAdmin effectuant l'action
   */
  async suspendOrganization(orgId: string, actorId: string): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, status: true },
    });
    if (!org) throw new NotFoundException('Organisation introuvable.');
    if (org.status === 'SUSPENDED') return;

    const before = { status: org.status };
    await this.prisma.$transaction([
      this.prisma.organization.update({
        where: { id: orgId },
        data: { status: 'SUSPENDED' },
      }),
      this.prisma.auditLog.create({
        data: {
          organizationId: orgId,
          actorType: 'PLATFORM_ADMIN',
          actorId,
          action: 'organization.suspend',
          entity: 'Organization',
          entityId: orgId,
          before,
          after: { status: 'SUSPENDED' },
        },
      }),
    ]);

    await this.redis.set(`platform:org-suspended:${orgId}`, '1', ORG_SUSPENDED_TTL_S);
  }

  /**
   * Réactive une organisation suspendue (idempotent si déjà active).
   *
   * Actions atomiques (Prisma $transaction) :
   * 1. Organization.status → ACTIVE
   * 2. AuditLog créé
   * Puis (hors transaction) :
   * 3. Clé Redis platform:org-suspended:<orgId> supprimée
   *
   * @param orgId   - UUID de l'organisation à réactiver
   * @param actorId - UUID du PlatformAdmin effectuant l'action
   */
  async reactivateOrganization(orgId: string, actorId: string): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, status: true },
    });
    if (!org) throw new NotFoundException('Organisation introuvable.');
    if (org.status === 'ACTIVE') return;

    const before = { status: org.status };
    await this.prisma.$transaction([
      this.prisma.organization.update({
        where: { id: orgId },
        data: { status: 'ACTIVE' },
      }),
      this.prisma.auditLog.create({
        data: {
          organizationId: orgId,
          actorType: 'PLATFORM_ADMIN',
          actorId,
          action: 'organization.reactivate',
          entity: 'Organization',
          entityId: orgId,
          before,
          after: { status: 'ACTIVE' },
        },
      }),
    ]);

    await this.redis.del(`platform:org-suspended:${orgId}`);
  }
}
