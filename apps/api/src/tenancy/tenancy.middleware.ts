import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenantContextService } from './tenant-context.service';
import { TenancyService } from './tenancy.service';
import { SUBDOMAIN_REGEX } from './tenancy.constants';

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
    private readonly tenancyService: TenancyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const subdomain = this.extractSubdomain(req.hostname ?? '');

    if (!subdomain) {
      res.status(404).json({ message: 'Organisation introuvable' });
      return;
    }

    const organizationId = await this.tenancyService.resolveOrganizationId(subdomain);

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
    const sub = parts[0] ?? '';

    // Valide le format RFC 1123 pour éviter tout vecteur d'injection par le header Host
    return SUBDOMAIN_REGEX.test(sub) ? sub : null;
  }
}
