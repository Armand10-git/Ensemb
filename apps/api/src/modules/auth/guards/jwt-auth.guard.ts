import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantContextService } from '../../../tenancy/tenant-context.service';
import type { AuthenticatedUser } from '../strategies/jwt.strategy';

/**
 * Étend le guard JWT standard pour vérifier que l'organisation encodée dans le token
 * correspond au contexte tenant posé par le middleware de résolution de sous-domaine.
 *
 * Bloque toute tentative d'accès inter-tenant via manipulation du header X-Organization-Id :
 * même avec un JWT valide, un utilisateur ne peut pas accéder aux données d'une autre
 * organisation en falsifiant ce header.
 *
 * Routes exemptées du middleware tenant (auth/public/platform-admin) : tryGetOrganizationId()
 * retourne null, la vérification est sautée — comportement attendu pour le login/logout.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly tenantContext: TenantContextService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const result = (await super.canActivate(context)) as boolean;
    if (!result) return false;

    // Pas de contexte tenant (route auth/public/platform-admin) → pas de vérification
    const tenantOrgId = this.tenantContext.tryGetOrganizationId();
    if (tenantOrgId === null) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (req.user?.organizationId !== tenantOrgId) {
      throw new ForbiddenException(
        'Accès refusé : le token appartient à une autre organisation.',
      );
    }

    return true;
  }
}
