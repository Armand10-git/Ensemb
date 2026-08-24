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
import type { DocumentStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { ViewAllInterceptor, type ViewAllRequest } from '../../common/interceptors/view-all.interceptor';
import { QuotationService } from './quotation.service';
import { CreateQuotationSchema } from './dto/create-quotation.dto';
import { UpdateQuotationSchema } from './dto/update-quotation.dto';
import { SendQuotationSchema } from './dto/send-quotation.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOCUMENT_STATUSES = ['PENDING', 'AWAITING_PAYMENT', 'COMPLETED', 'CANCELLED'];

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * Endpoints CRUD des devis (S28, §18.4) — mirror de SaleController (S19) sans les routes
 * validate/cancel (inexistantes pour un devis, aucun stock en jeu), avec la route
 * supplémentaire de conversion en vente.
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/quotations             → liste paginée (records.viewAll via ViewAllInterceptor)
 *   POST   /api/v1/quotations             → 201 (statut PENDING)
 *   GET    /api/v1/quotations/:id         → détail avec lignes, client, entrepôt
 *   PATCH  /api/v1/quotations/:id         → 200 (PENDING uniquement)
 *   POST   /api/v1/quotations/:id/convert → 201 (S28 — PENDING → COMPLETED, crée une Sale)
 *   POST   /api/v1/quotations/:id/send    → 202 (envoi asynchrone du récapitulatif par email/SMS)
 *   POST   /api/v1/quotations/:id/pdf     → 202 (S34 — génération PDF asynchrone, brandée)
 *   DELETE /api/v1/quotations/:id         → 204 (PENDING uniquement)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('quotations')
export class QuotationController {
  constructor(private readonly quotationService: QuotationService) {}

  /**
   * GET /api/v1/quotations
   * Liste paginée des devis, filtrable par clientId, warehouseId, status.
   * ViewAllInterceptor injecte request.viewAll selon la permission records.viewAll :
   * si absente, seuls les devis créés par l'utilisateur sont retournés.
   */
  @RequirePermission('quotations.view')
  @UseInterceptors(ViewAllInterceptor)
  @Get()
  findAll(
    @Req() req: ViewAllRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('clientId') clientId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('status') status?: string,
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

    return this.quotationService.findAll(
      req.user.organizationId,
      req.user.id,
      req.viewAll,
      p,
      l,
      clientId,
      warehouseId,
      validStatus,
    );
  }

  /**
   * POST /api/v1/quotations
   * Crée un devis en statut PENDING avec N lignes, totaux calculés côté serveur.
   */
  @RequirePermission('quotations.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateQuotationSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.quotationService.create(req.user.organizationId, req.user.id, result.data);
  }

  /**
   * GET /api/v1/quotations/:id
   * Retourne un devis avec ses lignes, son client et son entrepôt.
   */
  @RequirePermission('quotations.view')
  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.quotationService.findOne(id, req.user.organizationId);
  }

  /**
   * PATCH /api/v1/quotations/:id
   * Met à jour un devis PENDING — totaux recalculés côté serveur.
   */
  @RequirePermission('quotations.edit')
  @Patch(':id')
  @Auditable({ action: 'quotations.edit', entity: 'Quotation' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateQuotationSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.quotationService.update(id, req.user.organizationId, result.data);
  }

  /**
   * POST /api/v1/quotations/:id/convert
   * Convertit un devis PENDING en vente (S28, §18.4) : crée une Sale PENDING avec les
   * mêmes lignes (référence issue de la séquence des ventes classiques), fait passer le
   * devis à COMPLETED. Aucun mouvement de stock.
   */
  @RequirePermission('quotations.convert')
  @Post(':id/convert')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'quotations.convert', entity: 'Quotation' })
  convert(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.quotationService.convert(id, req.user.organizationId, req.user.id);
  }

  /**
   * POST /api/v1/quotations/:id/send
   * Envoie le récapitulatif d'un devis au client par email ou SMS — enfile un job BullMQ
   * traité de façon asynchrone par un worker dédié (202 Accepted, pas d'attente de
   * l'envoi réel). channel: 'email' | 'sms' dans le body.
   *
   * Réutilise la permission `quotations.view` plutôt qu'une nouvelle permission dédiée :
   * envoyer le récapitulatif est une action de partage sur une ressource déjà consultable
   * par l'utilisateur (pas une mutation du devis lui-même) — même décision que pour
   * SaleController.send() (S24), pas de permission `quotations.send` distincte en seed.
   */
  @RequirePermission('quotations.view')
  @Post(':id/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ action: 'quotations.send', entity: 'Quotation' })
  send(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = SendQuotationSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.quotationService.send(id, req.user.organizationId, result.data.channel);
  }

  /**
   * POST /api/v1/quotations/:id/pdf
   * Enfile la génération PDF brandée du devis (S34, mirror exact de POST /sales/:id/pdf) —
   * job BullMQ traité de façon asynchrone (202 Accepted). Le frontend écoute l'événement
   * temps réel `pdf:ready` (org-scopé) pour récupérer l'URL signée du PDF généré.
   *
   * Réutilise la permission `quotations.view` plutôt qu'une nouvelle permission dédiée —
   * même décision que send().
   */
  @RequirePermission('quotations.view')
  @Post(':id/pdf')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ action: 'quotations.generatePdf', entity: 'Quotation' })
  generatePdf(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.quotationService.generatePdf(id, req.user.organizationId, req.user.id);
  }

  /**
   * DELETE /api/v1/quotations/:id
   * Soft-delete d'un devis — uniquement si statut PENDING (204 No Content).
   */
  @RequirePermission('quotations.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'quotations.delete', entity: 'Quotation' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.quotationService.remove(id, req.user.organizationId);
  }
}
