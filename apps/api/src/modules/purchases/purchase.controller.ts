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
import { PurchaseService } from './purchase.service';
import { CreatePurchaseSchema } from './dto/create-purchase.dto';
import { UpdatePurchaseSchema } from './dto/update-purchase.dto';
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
 * Endpoints CRUD des achats fournisseurs (S25 — Bloc F, mirror exact de SaleController).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/purchases             → liste paginée (records.viewAll via ViewAllInterceptor)
 *   POST   /api/v1/purchases             → 201 (statut PENDING)
 *   GET    /api/v1/purchases/:id         → détail avec lignes, fournisseur, entrepôt
 *   PATCH  /api/v1/purchases/:id         → 200 (PENDING uniquement)
 *   PATCH  /api/v1/purchases/:id/validate → 200 (PENDING → COMPLETED, incrémente le stock)
 *   POST   /api/v1/purchases/:id/send    → 202 (S32 — envoi asynchrone du récapitulatif par email)
 *   DELETE /api/v1/purchases/:id         → 204 (PENDING uniquement)
 *
 * Pas de route /cancel dans cette session — purchases.cancel existe en permission mais
 * PurchaseService.cancel() n'est pas implémenté (écart assumé, cf. rapport de session).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('purchases')
export class PurchaseController {
  constructor(private readonly purchaseService: PurchaseService) {}

  /**
   * GET /api/v1/purchases
   * Liste paginée des achats, filtrable par providerId, warehouseId, status, paymentStatus.
   * ViewAllInterceptor injecte request.viewAll selon la permission records.viewAll :
   * si absente, seuls les achats créés par l'utilisateur sont retournés.
   */
  @RequirePermission('purchases.view')
  @UseInterceptors(ViewAllInterceptor)
  @Get()
  findAll(
    @Req() req: ViewAllRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('providerId') providerId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
  ) {
    if (providerId !== undefined && !UUID_RE.test(providerId)) {
      throw new BadRequestException('providerId doit être un UUID valide.');
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

    return this.purchaseService.findAll(
      req.user.organizationId,
      req.user.id,
      req.viewAll,
      p,
      l,
      providerId,
      warehouseId,
      validStatus,
      validPaymentStatus,
    );
  }

  /**
   * POST /api/v1/purchases
   * Crée un achat en statut PENDING avec N lignes, totaux calculés côté serveur.
   */
  @RequirePermission('purchases.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreatePurchaseSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.purchaseService.create(req.user.organizationId, req.user.id, result.data);
  }

  /**
   * GET /api/v1/purchases/:id
   * Retourne un achat avec ses lignes, son fournisseur et son entrepôt.
   */
  @RequirePermission('purchases.view')
  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseService.findOne(id, req.user.organizationId);
  }

  /**
   * PATCH /api/v1/purchases/:id
   * Met à jour un achat PENDING — totaux recalculés côté serveur.
   */
  @RequirePermission('purchases.edit')
  @Patch(':id')
  @Auditable({ action: 'purchases.edit', entity: 'Purchase' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdatePurchaseSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.purchaseService.update(id, req.user.organizationId, result.data);
  }

  /**
   * PATCH /api/v1/purchases/:id/validate
   * Valide un achat PENDING : incrémente le stock de l'entrepôt de l'achat
   * (verrouillage optimiste, conversion d'unité, création du ProductWarehouse si absent)
   * puis fait passer le statut à COMPLETED. Indépendant de paymentStatus/PaymentPurchase.
   */
  @RequirePermission('purchases.validate')
  @Patch(':id/validate')
  @Auditable({ action: 'purchases.validate', entity: 'Purchase' })
  validate(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseService.validate(id, req.user.organizationId);
  }

  /**
   * POST /api/v1/purchases/:id/send
   * Envoie le récapitulatif d'un achat au fournisseur par email (S32, mirror exact de
   * POST /api/v1/sales/:id/send, S24) — enfile un job BullMQ traité de façon asynchrone par
   * un worker dédié (202 Accepted, pas d'attente de l'envoi réel). Un seul canal (email) cette
   * session — pas de body attendu.
   *
   * Réutilise la permission `purchases.view` plutôt qu'une nouvelle permission dédiée — même
   * décision que SaleController.send (S24) : envoyer le récapitulatif est une action de
   * partage sur une ressource déjà consultable, pas une mutation de l'achat lui-même.
   */
  @RequirePermission('purchases.view')
  @Post(':id/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ action: 'purchases.send', entity: 'Purchase' })
  send(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseService.send(id, req.user.organizationId);
  }

  /**
   * DELETE /api/v1/purchases/:id
   * Soft-delete d'un achat — uniquement si statut PENDING (204 No Content).
   */
  @RequirePermission('purchases.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'purchases.delete', entity: 'Purchase' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.purchaseService.remove(id, req.user.organizationId);
  }
}
