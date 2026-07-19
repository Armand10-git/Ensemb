import { BadRequestException, Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TenancyService } from './tenancy.service';
import { SUBDOMAIN_REGEX } from './tenancy.constants';

interface PublicOrganizationResponse {
  organizationId: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

/**
 * Endpoint public permettant au frontend mobile de résoudre un tenant
 * sans dépendre de l'en-tête Host. Exempt du middleware TenancyMiddleware.
 */
@Controller('public/organizations')
export class PublicOrganizationsController {
  constructor(private readonly tenancyService: TenancyService) {}

  /**
   * Résout un sous-domaine en données publiques de l'organisation (id, branding).
   * Répond 404 neutre si le sous-domaine est inconnu.
   * Rate-limitée à 10 req/min pour bloquer l'énumération de sous-domaines.
   * N'expose aucun champ sensible (statut billing, secrets, etc.).
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('by-subdomain/:subdomain')
  async bySubdomain(
    @Param('subdomain') subdomain: string,
  ): Promise<PublicOrganizationResponse> {
    // Validation format RFC 1123 — rejette tout vecteur d'injection ou d'énumération anormal
    if (!SUBDOMAIN_REGEX.test(subdomain)) {
      throw new BadRequestException('Format de sous-domaine invalide');
    }

    const org = await this.tenancyService.resolvePublicOrganization(subdomain);

    if (!org) {
      // Réponse neutre — ne révèle pas si le sous-domaine existe ou non
      throw new NotFoundException('Organisation introuvable');
    }

    return org;
  }
}
