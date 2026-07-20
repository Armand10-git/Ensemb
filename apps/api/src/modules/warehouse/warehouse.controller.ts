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
import { WarehouseService } from './warehouse.service';
import { CreateWarehouseSchema, UpdateWarehouseSchema } from './dto/warehouse.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * CRUD entrepôts tenant.
 * Tous les endpoints exigent JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('warehouses')
export class WarehouseController {
  constructor(private readonly warehouseService: WarehouseService) {}

  /** GET /api/v1/warehouses — liste paginée des entrepôts actifs de l'organisation. */
  @RequirePermission('warehouses.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.warehouseService.findAll(req.user.organizationId, p, l);
  }

  /** GET /api/v1/warehouses/:id — détail d'un entrepôt de l'organisation. */
  @RequirePermission('warehouses.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouseService.findOne(id, req.user.organizationId);
  }

  /** POST /api/v1/warehouses — crée un entrepôt. */
  @RequirePermission('warehouses.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateWarehouseSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.warehouseService.create(req.user.organizationId, result.data);
  }

  /** PATCH /api/v1/warehouses/:id — modifie un entrepôt. */
  @RequirePermission('warehouses.edit')
  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateWarehouseSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.warehouseService.update(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/warehouses/:id — soft-delete d'un entrepôt (204 No Content). */
  @RequirePermission('warehouses.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.warehouseService.remove(id, req.user.organizationId);
  }
}
