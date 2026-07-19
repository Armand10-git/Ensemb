import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';

const SUBDOMAIN_CACHE_TTL_SECONDS = 3600;
const CACHE_KEY_PREFIX = 'org:bySubdomain:';

/**
 * Endpoint public permettant au frontend mobile de résoudre un tenant
 * sans dépendre de l'en-tête Host. Exempt du middleware TenancyMiddleware.
 */
@Controller('public/organizations')
export class PublicOrganizationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Résout un sous-domaine en organizationId.
   * Répond 404 neutre si le sous-domaine est inconnu.
   */
  @Get('by-subdomain/:subdomain')
  async bySubdomain(@Param('subdomain') subdomain: string): Promise<{ organizationId: string }> {
    const cacheKey = `${CACHE_KEY_PREFIX}${subdomain}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) return { organizationId: cached };

    const org = await this.prisma.organization.findUnique({
      where: { subdomain },
      select: { id: true },
    });

    if (!org) {
      // Réponse neutre — ne révèle pas si le sous-domaine existe ou non
      throw new NotFoundException('Organisation introuvable');
    }

    await this.redis.set(cacheKey, org.id, SUBDOMAIN_CACHE_TTL_SECONDS);
    return { organizationId: org.id };
  }
}
