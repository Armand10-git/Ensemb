import {
  BadRequestException,
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
  UseInterceptors,
} from '@nestjs/common';
import type { DocumentStatus, PaymentStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { ViewAllInterceptor, type ViewAllRequest } from '../../common/interceptors/view-all.interceptor';
import { SaleService } from './sale.service';
import { CreateSaleSchema } from './dto/create-sale.dto';
import { UpdateSaleSchema } from './dto/update-sale.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOCUMENT_STATUSES = ['PENDING', 'AWAITING_PAYMENT', 'COMPLETED', 'CANCELLED'];
const PAYMENT_STATUSES = ['PAID', 'PARTIAL', 'UNPAID'];

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * Endpoints CRUD des ventes classiques hors-POS (S19 — Bloc E, §18.3).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/sales      → liste paginée (records.viewAll via ViewAllInterceptor)
 *   POST   /api/v1/sales      → 201 (statut PENDING)
 *   GET    /api/v1/sales/:id  → détail avec lignes, client, entrepôt
 *   PATCH  /api/v1/sales/:id  → 200 (PENDING uniquement)
 *   DELETE /api/v1/sales/:id  → 204 (PENDING uniquement)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('sales')
export class SaleController {
  constructor(private readonly saleService: SaleService) {}

  /**
   * GET /api/v1/sales
   * Liste paginée des ventes, filtrable par clientId, warehouseId, status, paymentStatus.
   * ViewAllInterceptor injecte request.viewAll selon la permission records.viewAll :
   * si absente, seules les ventes créées par l'utilisateur sont retournées.
   */
  @RequirePermission('sales.view')
  @UseInterceptors(ViewAllInterceptor)
  @Get()
  findAll(
    @Req() req: ViewAllRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('clientId') clientId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
  ) {
    if (clientId !== undefined && !UUID_RE.test(clientId)) {
      throw new BadRequestException('clientId doit être un UUID valide.');
    }
    if (warehouseId !== undefined && !UUID_RE.test(warehouseId)) {
      throw new BadRequestException('warehouseId doit être un UUID valide.');
    }

    const { page: p, limit: l } = parsePagination(page, limit);
    const validStatus = DOCUMENT_STATUSES.includes(String(status))
      ? (status as DocumentStatus)
      : undefined;
    const validPaymentStatus = PAYMENT_STATUSES.includes(String(paymentStatus))
      ? (paymentStatus as PaymentStatus)
      : undefined;

    return this.saleService.findAll(
      req.user.organizationId,
      req.user.id,
      req.viewAll,
      p,
      l,
      clientId,
      warehouseId,
      validStatus,
      validPaymentStatus,
    );
  }

  /**
   * POST /api/v1/sales
   * Crée une vente en statut PENDING avec N lignes, totaux calculés côté serveur.
   */
  @RequirePermission('sales.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'sales.create', entity: 'Sale' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateSaleSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.saleService.create(req.user.organizationId, req.user.id, result.data);
  }

  /**
   * GET /api/v1/sales/:id
   * Retourne une vente avec ses lignes, son client et son entrepôt.
   */
  @RequirePermission('sales.view')
  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saleService.findOne(id, req.user.organizationId);
  }

  /**
   * PATCH /api/v1/sales/:id
   * Met à jour une vente PENDING — totaux recalculés côté serveur.
   */
  @RequirePermission('sales.edit')
  @Patch(':id')
  @Auditable({ action: 'sales.edit', entity: 'Sale' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateSaleSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.saleService.update(id, req.user.organizationId, result.data);
  }

  /**
   * DELETE /api/v1/sales/:id
   * Soft-delete d'une vente — uniquement si statut PENDING (204 No Content).
   */
  @RequirePermission('sales.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'sales.delete', entity: 'Sale' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.saleService.remove(id, req.user.organizationId);
  }
}
