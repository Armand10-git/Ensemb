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
import { PurchaseReturnService } from './purchase-return.service';
import { CreatePurchaseReturnSchema } from './dto/create-purchase-return.dto';
import { UpdatePurchaseReturnSchema } from './dto/update-purchase-return.dto';
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
 * Endpoints CRUD des retours fournisseurs (S26, mirror exact de PurchaseController).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/purchase-returns             → liste paginée (records.viewAll via ViewAllInterceptor)
 *   POST   /api/v1/purchase-returns             → 201 (statut PENDING)
 *   GET    /api/v1/purchase-returns/:id         → détail avec lignes, achat d'origine, entrepôt
 *   PATCH  /api/v1/purchase-returns/:id         → 200 (PENDING uniquement)
 *   PATCH  /api/v1/purchase-returns/:id/validate → 200 (PENDING → COMPLETED, décrémente le stock)
 *   POST   /api/v1/purchase-returns/:id/send    → 202 (S32 — envoi asynchrone du récapitulatif par email)
 *   DELETE /api/v1/purchase-returns/:id         → 204 (PENDING uniquement)
 *
 * Pas de route /cancel dans cette session — mirror de purchases.cancel (S25, écart assumé).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('purchase-returns')
export class PurchaseReturnController {
  constructor(private readonly purchaseReturnService: PurchaseReturnService) {}

  /**
   * GET /api/v1/purchase-returns
   * Liste paginée des retours fournisseurs, filtrable par purchaseId, warehouseId, status,
   * paymentStatus. ViewAllInterceptor injecte request.viewAll selon la permission
   * records.viewAll : si absente, seuls les retours créés par l'utilisateur sont retournés.
   */
  @RequirePermission('purchaseReturns.view')
  @UseInterceptors(ViewAllInterceptor)
  @Get()
  findAll(
    @Req() req: ViewAllRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('purchaseId') purchaseId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
  ) {
    if (purchaseId !== undefined && !UUID_RE.test(purchaseId)) {
      throw new BadRequestException('purchaseId doit être un UUID valide.');
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

    return this.purchaseReturnService.findAll(
      req.user.organizationId,
      req.user.id,
      req.viewAll,
      p,
      l,
      purchaseId,
      warehouseId,
      validStatus,
      validPaymentStatus,
    );
  }

  /**
   * POST /api/v1/purchase-returns
   * Crée un retour fournisseur en statut PENDING avec N lignes ; price/taxAmount/
   * taxMethod/discount/discountMethod sont copiés depuis la PurchaseDetail source, jamais
   * acceptés depuis le body — totaux calculés côté serveur.
   */
  @RequirePermission('purchaseReturns.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreatePurchaseReturnSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.purchaseReturnService.create(req.user.organizationId, req.user.id, result.data);
  }

  /**
   * GET /api/v1/purchase-returns/:id
   * Retourne un retour fournisseur avec ses lignes, l'achat d'origine et l'entrepôt.
   */
  @RequirePermission('purchaseReturns.view')
  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseReturnService.findOne(id, req.user.organizationId);
  }

  /**
   * PATCH /api/v1/purchase-returns/:id
   * Met à jour un retour PENDING — totaux recalculés côté serveur.
   */
  @RequirePermission('purchaseReturns.edit')
  @Patch(':id')
  @Auditable({ action: 'purchaseReturns.edit', entity: 'PurchaseReturn' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdatePurchaseReturnSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.purchaseReturnService.update(id, req.user.organizationId, result.data);
  }

  /**
   * PATCH /api/v1/purchase-returns/:id/validate
   * Valide un retour PENDING : décrémente le stock de l'entrepôt du retour (verrouillage
   * optimiste, conversion d'unité, garde stock insuffisant, garde cumulée anti-sur-retour)
   * puis fait passer le statut à COMPLETED. Indépendant de paymentStatus/PaymentReturn.
   */
  @RequirePermission('purchaseReturns.validate')
  @Patch(':id/validate')
  @Auditable({ action: 'purchaseReturns.validate', entity: 'PurchaseReturn' })
  validate(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseReturnService.validate(id, req.user.organizationId);
  }

  /**
   * POST /api/v1/purchase-returns/:id/send
   * Envoie le récapitulatif d'un retour fournisseur au fournisseur par email (S32, mirror
   * exact de POST /api/v1/sale-returns/:id/send) — enfile un job BullMQ traité de façon
   * asynchrone par un worker dédié (202 Accepted). Un seul canal (email) cette session — pas
   * de body attendu.
   *
   * Réutilise la permission `purchaseReturns.view` plutôt qu'une nouvelle permission dédiée.
   */
  @RequirePermission('purchaseReturns.view')
  @Post(':id/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ action: 'purchaseReturns.send', entity: 'PurchaseReturn' })
  send(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseReturnService.send(id, req.user.organizationId);
  }

  /**
   * DELETE /api/v1/purchase-returns/:id
   * Soft-delete d'un retour fournisseur — uniquement si statut PENDING (204 No Content).
   */
  @RequirePermission('purchaseReturns.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'purchaseReturns.delete', entity: 'PurchaseReturn' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.purchaseReturnService.remove(id, req.user.organizationId);
  }
}
