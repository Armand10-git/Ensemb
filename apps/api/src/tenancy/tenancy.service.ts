import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { SUBDOMAIN_CACHE_KEY_PREFIX, SUBDOMAIN_CACHE_TTL_SECONDS } from './tenancy.constants';

/**
 * Logique de résolution sous-domaine → organizationId, partagée par le middleware
 * et le contrôleur public. Lookup Redis (cache) puis fallback Prisma.
 */
@Injectable()
export class TenancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Résout un sous-domaine en organizationId.
   * Retourne null si le sous-domaine est inconnu — l'appelant décide de la réponse.
   */
  async resolveOrganizationId(subdomain: string): Promise<string | null> {
    const cacheKey = `${SUBDOMAIN_CACHE_KEY_PREFIX}${subdomain}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const org = await this.prisma.organization.findUnique({
      where: { subdomain },
      select: { id: true },
    });

    if (!org) return null;

    await this.redis.set(cacheKey, org.id, SUBDOMAIN_CACHE_TTL_SECONDS);
    return org.id;
  }

  /**
   * Résout un sous-domaine en données publiques de l'organisation.
   * Retourne null si le sous-domaine est inconnu.
   * N'expose aucun champ sensible (statut billing, secrets, etc.).
   */
  async resolvePublicOrganization(
    subdomain: string,
  ): Promise<{ organizationId: string; logoUrl: string | null; primaryColor: string | null } | null> {
    const org = await this.prisma.organization.findUnique({
      where: { subdomain, deletedAt: null },
      select: { id: true, logoUrl: true, primaryColor: true },
    });

    if (!org) return null;

    return {
      organizationId: org.id,
      logoUrl: org.logoUrl ?? null,
      primaryColor: org.primaryColor ?? null,
    };
  }
}
