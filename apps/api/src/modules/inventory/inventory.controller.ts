import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ProductWarehouseService } from './product-warehouse.service';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

// ─── DTO init stock ──────────────────────────────────────────────────────────

const InitStockSchema = z.object({
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  /** Quantité initiale — doit être ≥ 0 ; par défaut 0. */
  quantity: z
    .string()
    .optional()
    .refine((v) => v === undefined || (!isNaN(Number(v)) && Number(v) >= 0), {
      message: 'quantity doit être un nombre positif ou nul.',
    }),
});

type InitStockDto = z.infer<typeof InitStockSchema>;

/**
 * Endpoints de consultation et d'initialisation du stock par entrepôt (S15).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('inventory/stock')
export class InventoryController {
  constructor(private readonly productWarehouseService: ProductWarehouseService) {}

  /**
   * Retourne le stock de ce produit par entrepôt.
   * GET /api/v1/inventory/stock/product/:productId
   */
  @Get('product/:productId')
  @RequirePermission('adjustments.view')
  findByProduct(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.productWarehouseService.findByProduct(productId, req.user.organizationId);
  }

  /**
   * Retourne le résumé de stock d'un produit : total + détail par entrepôt.
   * Le total est calculé côté serveur en Decimal (§17 point A).
   * GET /api/v1/inventory/stock/summary/:productId
   */
  @Get('summary/:productId')
  @RequirePermission('adjustments.view')
  getStockSummary(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.productWarehouseService.getStockSummary(productId, req.user.organizationId);
  }

  /**
   * Retourne le stock paginé d'un entrepôt.
   * GET /api/v1/inventory/stock/warehouse/:warehouseId
   */
  @Get('warehouse/:warehouseId')
  @RequirePermission('adjustments.view')
  findByWarehouse(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    return this.productWarehouseService.findByWarehouse(
      warehouseId,
      req.user.organizationId,
      safePage,
      safeLimit,
    );
  }

  /**
   * Initialise le stock d'un (produit, entrepôt) à zéro (idempotent).
   * POST /api/v1/inventory/stock/init
   */
  @Post('init')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('adjustments.create')
  async initStock(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = InitStockSchema.safeParse(body);
    if (!parsed.success) {
      const { BadRequestException } = await import('@nestjs/common');
      throw new BadRequestException(
        parsed.error.issues.map((i) => i.message).join(', '),
      );
    }

    const dto: InitStockDto = parsed.data;
    const quantity = dto.quantity !== undefined ? new Decimal(dto.quantity) : undefined;

    return this.productWarehouseService.initStock(
      dto.productId,
      dto.warehouseId,
      req.user.organizationId,
      quantity,
    );
  }
}
