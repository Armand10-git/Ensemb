import { BadRequestException, Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TenancyService } from './tenancy.service';
import { SUBDOMAIN_REGEX } from './tenancy.constants';

/**
 * Endpoint public permettant au frontend mobile de résoudre un tenant
 * sans dépendre de l'en-tête Host. Exempt du middleware TenancyMiddleware.
 */
@Controller('public/organizations')
export class PublicOrganizationsController {
  constructor(private readonly tenancyService: TenancyService) {}

  /**
   * Résout un sous-domaine en organizationId.
   * Répond 404 neutre si le sous-domaine est inconnu.
   * Rate-limitée à 10 req/min pour bloquer l'énumération de sous-domaines.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('by-subdomain/:subdomain')
  async bySubdomain(@Param('subdomain') subdomain: string): Promise<{ organizationId: string }> {
    // Validation format RFC 1123 — rejette tout vecteur d'injection ou d'énumération anormal
    if (!SUBDOMAIN_REGEX.test(subdomain)) {
      throw new BadRequestException('Format de sous-domaine invalide');
    }

    const organizationId = await this.tenancyService.resolveOrganizationId(subdomain);

    if (!organizationId) {
      // Réponse neutre — ne révèle pas si le sous-domaine existe ou non
      throw new NotFoundException('Organisation introuvable');
    }

    return { organizationId };
  }
}
