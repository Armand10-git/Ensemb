import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenantContextService } from './tenant-context.service';
import { TenancyService } from './tenancy.service';
import { SUBDOMAIN_REGEX } from './tenancy.constants';

/** Détecte une adresse IPv4 littérale (ex. 127.0.0.1) — jamais un sous-domaine valide. */
const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

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
    // Routes exemptées de la résolution tenant (NestJS exclude() est peu fiable en v10
    // avec les patterns path-to-regexp — on gère ici en défense secondaire)
    // NestJS manipule req.path lors du dispatch de middleware — il faut req.originalUrl
    // pour obtenir le chemin complet original de la requête.
    const p = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '/';
    if (
      p === '/health' ||
      p === '/ready' ||
      p.startsWith('/api/v1/auth/') ||
      p.startsWith('/api/v1/public/') ||
      p.startsWith('/api/v1/platform-admin/')
    ) {
      return next();
    }

    // Priorité 1 : sous-domaine extrait du header Host (prod + staging)
    // Priorité 2 : header X-Organization-Id (dev localhost, mobile, outils CLI)
    const subdomain = this.extractSubdomain(req.hostname ?? '');
    let organizationId: string | null = null;

    if (subdomain) {
      organizationId = await this.tenancyService.resolveOrganizationId(subdomain);
    } else {
      // En dev (localhost / IP sans sous-domaine), on accepte l'ID direct.
      // En prod, ce chemin est inaccessible car le Host contient toujours le sous-domaine.
      const headerOrgId = req.headers['x-organization-id'];
      if (typeof headerOrgId === 'string' && headerOrgId.length > 0) {
        organizationId = headerOrgId;
      }
    }

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

    // En dev (localhost ou IP), pas de sous-domaine à extraire.
    // Une adresse IPv4 (ex. 127.0.0.1, hôte par défaut de supertest/Node en test)
    // contient des points mais n'est jamais un sous-domaine valide — sans cette garde,
    // son premier octet ("127") matche SUBDOMAIN_REGEX et court-circuite le fallback
    // X-Organization-Id prévu pour ce cas (dev localhost, mobile, outils CLI).
    if (!host.includes('.') || IPV4_REGEX.test(host)) return null;

    const parts = host.split('.');
    const sub = parts[0] ?? '';

    // Valide le format RFC 1123 pour éviter tout vecteur d'injection par le header Host
    return SUBDOMAIN_REGEX.test(sub) ? sub : null;
  }
}
