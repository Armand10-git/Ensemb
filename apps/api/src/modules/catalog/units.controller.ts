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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { UnitService } from './unit.service';
import { CreateUnitSchema, UpdateUnitSchema } from './dto/create-unit.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * CRUD unités de mesure tenant.
 * Tous les endpoints exigent JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('catalog/units')
export class UnitsController {
  constructor(private readonly unitService: UnitService) {}

  /** GET /api/v1/catalog/units — liste paginée des unités actives de l'organisation. */
  @RequirePermission('units.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.unitService.findAll(req.user.organizationId, p, l);
  }

  /** GET /api/v1/catalog/units/:id — détail d'une unité de l'organisation. */
  @RequirePermission('units.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.unitService.findOne(id, req.user.organizationId);
  }

  /** POST /api/v1/catalog/units — crée une unité (201). */
  @RequirePermission('units.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'units.create', entity: 'Unit' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateUnitSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.unitService.create(req.user.organizationId, result.data);
  }

  /** PATCH /api/v1/catalog/units/:id — modifie une unité. */
  @RequirePermission('units.edit')
  @Patch(':id')
  @Auditable({ action: 'units.update', entity: 'Unit' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateUnitSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.unitService.update(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/catalog/units/:id — soft-delete d'une unité (204 No Content). */
  @RequirePermission('units.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'units.delete', entity: 'Unit' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.unitService.remove(id, req.user.organizationId);
  }
}
