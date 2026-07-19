import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { TenantContextService } from './tenant-context.service';

const SUBDOMAIN_CACHE_TTL_SECONDS = 3600;
const CACHE_KEY_PREFIX = 'org:bySubdomain:';

/**
 * Extrait le sous-domaine du header Host, résout l'organisation via Redis (cache)
 * puis Prisma (fallback), et alimente l'AsyncLocalStorage tenant.
 *
 * Réponse neutre 404 sur tout sous-domaine inconnu — pas de différence 404 vs 401
 * pour éviter l'énumération de sous-domaines.
 */
@Injectable()
export class TenancyMiddleware implements NestMiddleware {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const subdomain = this.extractSubdomain(req.hostname ?? '');

    if (!subdomain) {
      res.status(404).json({ message: 'Organisation introuvable' });
      return;
    }

    const organizationId = await this.resolveOrganizationId(subdomain);

    if (!organizationId) {
      res.status(404).json({ message: 'Organisation introuvable' });
      return;
    }

    // Exécute le reste de la chaîne dans un contexte tenant isolé
    this.tenantContext.run(organizationId, () => next());
  }

  private extractSubdomain(hostname: string): string | null {
    // Retire le port si présent (ex. localhost:3000)
    const host = hostname.split(':')[0] ?? '';

    // En dev (localhost ou IP), pas de sous-domaine à extraire
    if (!host.includes('.')) return null;

    const parts = host.split('.');
    // Sous-domaine = premier segment, ex. "boutique-durand" dans "boutique-durand.monapp.com"
    // On rejette les wildcards ou segments vides
    const sub = parts[0];
    return sub && sub.length > 0 ? sub : null;
  }

  private async resolveOrganizationId(subdomain: string): Promise<string | null> {
    const cacheKey = `${CACHE_KEY_PREFIX}${subdomain}`;

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
}
