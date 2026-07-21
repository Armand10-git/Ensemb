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
import { AdjustmentStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { AdjustmentService } from './adjustment.service';
import { CreateAdjustmentSchema } from './dto/create-adjustment.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * Endpoints CRUD + validation des ajustements de stock (S16 — Bloc D).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/inventory/adjustments              → liste paginée
 *   POST   /api/v1/inventory/adjustments              → 201 (statut DRAFT)
 *   GET    /api/v1/inventory/adjustments/:id          → détail avec lignes
 *   PATCH  /api/v1/inventory/adjustments/:id/validate → 200 (VALIDATED + stock mouvementé)
 *   DELETE /api/v1/inventory/adjustments/:id          → 204 (DRAFT uniquement)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('inventory/adjustments')
export class AdjustmentController {
  constructor(private readonly adjustmentService: AdjustmentService) {}

  /**
   * GET /api/v1/inventory/adjustments
   * Liste paginée des ajustements, filtrable par warehouseId et status.
   */
  @RequirePermission('adjustments.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('status') status?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    const validStatus =
      status === 'DRAFT' || status === 'VALIDATED'
        ? (status as AdjustmentStatus)
        : undefined;
    return this.adjustmentService.findAll(
      req.user.organizationId,
      p,
      l,
      warehouseId,
      validStatus,
    );
  }

  /**
   * POST /api/v1/inventory/adjustments
   * Crée un ajustement en statut DRAFT avec N lignes.
   */
  @RequirePermission('adjustments.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateAdjustmentSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.adjustmentService.create(
      req.user.organizationId,
      req.user.id,
      result.data,
    );
  }

  /**
   * GET /api/v1/inventory/adjustments/:id
   * Retourne un ajustement avec ses lignes.
   */
  @RequirePermission('adjustments.view')
  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adjustmentService.findOne(id, req.user.organizationId);
  }

  /**
   * PATCH /api/v1/inventory/adjustments/:id/validate
   * Valide l'ajustement : mouvemente le stock de chaque ligne et passe en VALIDATED.
   * Idempotence garantie par le check status === DRAFT.
   */
  @RequirePermission('adjustments.create')
  @Patch(':id/validate')
  @Auditable({ action: 'adjustments.validate', entity: 'Adjustment' })
  validate(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adjustmentService.validate(id, req.user.organizationId);
  }

  /**
   * DELETE /api/v1/inventory/adjustments/:id
   * Soft-delete d'un ajustement — uniquement si statut DRAFT (204 No Content).
   */
  @RequirePermission('adjustments.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'adjustments.delete', entity: 'Adjustment' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.adjustmentService.remove(id, req.user.organizationId);
  }
}
