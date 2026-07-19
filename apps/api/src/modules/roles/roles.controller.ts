import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RolesService } from './roles.service';
import { CreateRoleSchema } from './dto/create-role.dto';
import { UpdateRoleSchema } from './dto/update-role.dto';
import { ManagePermissionsSchema } from './dto/manage-permissions.dto';
import { AssignRoleSchema } from './dto/assign-role.dto';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

interface AuthRequest extends Request {
  user: AuthenticatedUser;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Résout et valide l'organizationId depuis l'en-tête X-Organization-Id.
 * DETTE (T02) : à remplacer par résolution automatique via sous-domaine (TenancyModule).
 */
function resolveOrgId(req: Request): string {
  const orgId = req.headers['x-organization-id'];
  if (typeof orgId !== 'string' || !UUID_REGEX.test(orgId)) {
    throw new UnprocessableEntityException(
      'En-tête X-Organization-Id manquant ou invalide (UUID attendu).',
    );
  }
  return orgId;
}

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  /** GET /api/v1/roles — liste les rôles de l'organisation (paginée). */
  @RequirePermission('permissions.view')
  @Get()
  findAll(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const organizationId = resolveOrgId(req);
    return this.rolesService.findAll(organizationId, parsePagination(page, limit));
  }

  /** GET /api/v1/roles/:id — détail d'un rôle avec ses permissions. */
  @RequirePermission('permissions.view')
  @Get(':id')
  findOne(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    const organizationId = resolveOrgId(req);
    return this.rolesService.findOne(organizationId, id);
  }

  /** POST /api/v1/roles — crée un rôle. */
  @RequirePermission('permissions.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthRequest, @Body() body: unknown) {
    const organizationId = resolveOrgId(req);
    const result = CreateRoleSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.rolesService.create(organizationId, result.data);
  }

  /** PATCH /api/v1/roles/:id — modifie label, description ou statut. */
  @RequirePermission('permissions.edit')
  @Patch(':id')
  update(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const organizationId = resolveOrgId(req);
    const result = UpdateRoleSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.rolesService.update(organizationId, id, result.data);
  }

  /** DELETE /api/v1/roles/:id — désactive (soft delete) un rôle. */
  @RequirePermission('permissions.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    const organizationId = resolveOrgId(req);
    await this.rolesService.remove(organizationId, id);
  }

  /** POST /api/v1/roles/:id/permissions — ajoute des permissions au rôle. */
  @RequirePermission('permissions.edit')
  @Post(':id/permissions')
  addPermissions(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const organizationId = resolveOrgId(req);
    const result = ManagePermissionsSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.rolesService.addPermissions(organizationId, id, result.data.permissionIds);
  }

  /** DELETE /api/v1/roles/:id/permissions — retire des permissions du rôle. */
  @RequirePermission('permissions.edit')
  @Delete(':id/permissions')
  @HttpCode(HttpStatus.OK)
  removePermissions(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const organizationId = resolveOrgId(req);
    const result = ManagePermissionsSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.rolesService.removePermissions(organizationId, id, result.data.permissionIds);
  }

  /** POST /api/v1/roles/:id/users — assigne le rôle à un utilisateur. */
  @RequirePermission('permissions.edit')
  @Post(':id/users')
  @HttpCode(HttpStatus.NO_CONTENT)
  async assignRole(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const organizationId = resolveOrgId(req);
    const result = AssignRoleSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    await this.rolesService.assignRole(organizationId, id, result.data.userId);
  }

  /** DELETE /api/v1/roles/:id/users/:userId — révoque le rôle d'un utilisateur. */
  @RequirePermission('permissions.edit')
  @Delete(':id/users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeRole(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const organizationId = resolveOrgId(req);
    await this.rolesService.revokeRole(organizationId, id, userId);
  }
}
