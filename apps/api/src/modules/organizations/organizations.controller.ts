import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { OrganizationsService } from './organizations.service';
import { UpdateBrandingSchema } from './dto/update-branding.dto';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { BrandingResult } from './organizations.service';

interface AuthRequest extends Request {
  user: AuthenticatedUser;
}

/**
 * Endpoints de gestion de l'organisation du tenant authentifié.
 * organizationId est toujours extrait de req.user — jamais du body (IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  /**
   * PATCH /api/v1/organizations/branding
   * Met à jour logoUrl et/ou primaryColor de l'organisation du tenant connecté.
   * Répond 422 si le body ne passe pas la validation zod.
   */
  @RequirePermission('organization.branding.edit')
  @Auditable({ action: 'ORGANIZATION_BRANDING_UPDATE', entity: 'Organization' })
  @Patch('branding')
  @HttpCode(HttpStatus.OK)
  async updateBranding(@Req() req: AuthRequest, @Body() body: unknown): Promise<BrandingResult> {
    const parsed = UpdateBrandingSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        parsed.error.issues.map((issue) => issue.message).join(', '),
      );
    }

    return this.organizationsService.updateBranding(req.user.organizationId, parsed.data);
  }
}
