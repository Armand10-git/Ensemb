import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Request } from 'express';
import { PlatformAdminGuard, AuthenticatedPlatformAdmin } from './platform-admin.guard';
import { PlatformAdminOrganizationsService } from './platform-admin-organizations.service';
import { ListOrganizationsSchema } from './dto/list-organizations.dto';

/**
 * Gestion des organisations depuis la console plateforme.
 * Préfixe : /api/v1/platform-admin/organizations
 * Tous les endpoints requièrent PlatformAdminGuard (token complet).
 */
@Controller('platform-admin/organizations')
@UseGuards(PlatformAdminGuard)
export class PlatformAdminOrganizationsController {
  constructor(private readonly orgService: PlatformAdminOrganizationsService) {}

  /** Liste paginée des organisations (statut, plan, date de création). */
  @Get()
  async list(@Query() query: unknown) {
    const result = ListOrganizationsSchema.safeParse(query);
    if (!result.success) throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    return this.orgService.listOrganizations(result.data.page, result.data.limit);
  }

  /** Suspend une organisation et bloque immédiatement ses utilisateurs. */
  @Patch(':id/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  async suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { platformAdmin?: AuthenticatedPlatformAdmin },
  ) {
    const actorId = (req.platformAdmin as AuthenticatedPlatformAdmin).id;
    await this.orgService.suspendOrganization(id, actorId);
  }

  /** Réactive une organisation suspendue. */
  @Patch(':id/reactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { platformAdmin?: AuthenticatedPlatformAdmin },
  ) {
    const actorId = (req.platformAdmin as AuthenticatedPlatformAdmin).id;
    await this.orgService.reactivateOrganization(id, actorId);
  }
}
