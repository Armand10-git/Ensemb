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
import { TransferStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { StockTransferService } from './stock-transfer.service';
import { CreateStockTransferSchema } from './dto/create-stock-transfer.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * Endpoints CRUD + validation des transferts de stock (S17 — Bloc D).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/inventory/transfers              → liste paginée
 *   POST   /api/v1/inventory/transfers              → 201 (statut DRAFT)
 *   GET    /api/v1/inventory/transfers/:id          → détail avec lignes
 *   PATCH  /api/v1/inventory/transfers/:id/validate → 200 (VALIDATED + stock mouvementé)
 *   DELETE /api/v1/inventory/transfers/:id          → 204 (DRAFT uniquement)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('inventory/transfers')
export class StockTransferController {
  constructor(private readonly transferService: StockTransferService) {}

  /**
   * GET /api/v1/inventory/transfers
   * Liste paginée des transferts, filtrable par fromWarehouseId, toWarehouseId et status.
   */
  @RequirePermission('transfers.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('fromWarehouseId') fromWarehouseId?: string,
    @Query('toWarehouseId') toWarehouseId?: string,
    @Query('status') status?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    const validStatus =
      status === 'DRAFT' || status === 'VALIDATED'
        ? (status as TransferStatus)
        : undefined;
    return this.transferService.findAll(
      req.user.organizationId,
      p,
      l,
      fromWarehouseId,
      toWarehouseId,
      validStatus,
    );
  }

  /**
   * POST /api/v1/inventory/transfers
   * Crée un transfert en statut DRAFT avec N lignes.
   */
  @RequirePermission('transfers.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateStockTransferSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.transferService.create(
      req.user.organizationId,
      req.user.id,
      result.data,
    );
  }

  /**
   * GET /api/v1/inventory/transfers/:id
   * Retourne un transfert avec ses lignes.
   */
  @RequirePermission('transfers.view')
  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transferService.findOne(id, req.user.organizationId);
  }

  /**
   * PATCH /api/v1/inventory/transfers/:id/validate
   * Valide le transfert : décrémente le stock source, incrémente le stock destination.
   * Idempotence garantie par le check status === DRAFT dans la transaction Serializable.
   */
  @RequirePermission('transfers.validate')
  @Patch(':id/validate')
  @Auditable({ action: 'transfers.validate', entity: 'StockTransfer' })
  validate(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transferService.validate(id, req.user.organizationId);
  }

  /**
   * DELETE /api/v1/inventory/transfers/:id
   * Soft-delete d'un transfert — uniquement si statut DRAFT (204 No Content).
   */
  @RequirePermission('transfers.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'transfers.delete', entity: 'StockTransfer' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.transferService.remove(id, req.user.organizationId);
  }
}
