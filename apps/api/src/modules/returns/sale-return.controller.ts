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
import { SaleReturnService } from './sale-return.service';
import { CreateSaleReturnSchema } from './dto/create-sale-return.dto';
import { UpdateSaleReturnSchema } from './dto/update-sale-return.dto';
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
 * Endpoints CRUD des retours de vente (S26 — Bloc F/E, §18.6, mirror exact de SaleController).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/sale-returns             → liste paginée (records.viewAll via ViewAllInterceptor)
 *   POST   /api/v1/sale-returns             → 201 (statut PENDING)
 *   GET    /api/v1/sale-returns/:id         → détail avec lignes, vente d'origine, entrepôt
 *   PATCH  /api/v1/sale-returns/:id         → 200 (PENDING uniquement)
 *   PATCH  /api/v1/sale-returns/:id/validate → 200 (PENDING → COMPLETED, incrémente le stock)
 *   POST   /api/v1/sale-returns/:id/send    → 202 (S32 — envoi asynchrone du récapitulatif par email)
 *   DELETE /api/v1/sale-returns/:id         → 204 (PENDING uniquement)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('sale-returns')
export class SaleReturnController {
  constructor(private readonly saleReturnService: SaleReturnService) {}

  /**
   * GET /api/v1/sale-returns
   * Liste paginée des retours de vente, filtrable par saleId, warehouseId, status, paymentStatus.
   * ViewAllInterceptor injecte request.viewAll selon la permission records.viewAll :
   * si absente, seuls les retours créés par l'utilisateur sont retournés.
   */
  @RequirePermission('saleReturns.view')
  @UseInterceptors(ViewAllInterceptor)
  @Get()
  findAll(
    @Req() req: ViewAllRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('saleId') saleId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
  ) {
    if (saleId !== undefined && !UUID_RE.test(saleId)) {
      throw new BadRequestException('saleId doit être un UUID valide.');
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

    return this.saleReturnService.findAll(
      req.user.organizationId,
      req.user.id,
      req.viewAll,
      p,
      l,
      saleId,
      warehouseId,
      validStatus,
      validPaymentStatus,
    );
  }

  /**
   * POST /api/v1/sale-returns
   * Crée un retour de vente en statut PENDING avec N lignes, totaux calculés côté serveur.
   */
  @RequirePermission('saleReturns.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateSaleReturnSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.saleReturnService.create(req.user.organizationId, req.user.id, result.data);
  }

  /**
   * GET /api/v1/sale-returns/:id
   * Retourne un retour de vente avec ses lignes, sa vente d'origine et son entrepôt.
   */
  @RequirePermission('saleReturns.view')
  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saleReturnService.findOne(id, req.user.organizationId);
  }

  /**
   * PATCH /api/v1/sale-returns/:id
   * Met à jour un retour de vente PENDING — totaux recalculés côté serveur.
   */
  @RequirePermission('saleReturns.edit')
  @Patch(':id')
  @Auditable({ action: 'saleReturns.edit', entity: 'SaleReturn' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateSaleReturnSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.saleReturnService.update(id, req.user.organizationId, result.data);
  }

  /**
   * PATCH /api/v1/sale-returns/:id/validate
   * Valide un retour de vente PENDING : incrémente le stock de l'entrepôt du retour
   * (verrouillage optimiste, conversion d'unité, garde de quantité cumulée anti-sur-retour)
   * puis fait passer le statut à COMPLETED. Indépendant de paymentStatus/PaymentReturn.
   */
  @RequirePermission('saleReturns.validate')
  @Patch(':id/validate')
  @Auditable({ action: 'saleReturns.validate', entity: 'SaleReturn' })
  validate(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saleReturnService.validate(id, req.user.organizationId);
  }

  /**
   * POST /api/v1/sale-returns/:id/send
   * Envoie le récapitulatif d'un retour de vente au client par email (S32, mirror exact de
   * POST /api/v1/sales/:id/send, S24) — enfile un job BullMQ traité de façon asynchrone par
   * un worker dédié (202 Accepted). Un seul canal (email) cette session — pas de body attendu.
   *
   * Réutilise la permission `saleReturns.view` plutôt qu'une nouvelle permission dédiée.
   */
  @RequirePermission('saleReturns.view')
  @Post(':id/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ action: 'saleReturns.send', entity: 'SaleReturn' })
  send(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saleReturnService.send(id, req.user.organizationId);
  }

  /**
   * DELETE /api/v1/sale-returns/:id
   * Soft-delete d'un retour de vente — uniquement si statut PENDING (204 No Content).
   */
  @RequirePermission('saleReturns.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'saleReturns.delete', entity: 'SaleReturn' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.saleReturnService.remove(id, req.user.organizationId);
  }
}
