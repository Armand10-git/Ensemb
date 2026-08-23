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
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { PaymentSaleService } from './payment-sale.service';
import { CreatePaymentSchema } from './dto/create-payment.dto';
import { UpdatePaymentSchema } from './dto/update-payment.dto';
import { SendSaleSchema } from './dto/send-sale.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * Endpoints des paiements de ventes classiques hors-POS (S20 — Bloc E, §18.5).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId et userId sont toujours extraits de req.user — jamais de l'URL/body
 * (anti-IDOR). Chaque écriture recalcule Sale.paidAmount/paymentStatus côté service.
 *
 * Routes :
 *   GET    /api/v1/sales/:saleId/payments  → historique chronologique des paiements
 *   POST   /api/v1/sales/:saleId/payments  → 201 (encaisse un paiement)
 *   PATCH  /api/v1/sales/payments/:id      → 200
 *   POST   /api/v1/sales/payments/:id/send → 202 (S32/S33 — envoi asynchrone du reçu par email/SMS)
 *   DELETE /api/v1/sales/payments/:id      → 204 (suppression physique, cf. service)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('sales')
export class PaymentSaleController {
  constructor(private readonly paymentSaleService: PaymentSaleService) {}

  /**
   * GET /api/v1/sales/:saleId/payments
   * Retourne l'historique chronologique des paiements d'une vente.
   */
  @RequirePermission('paymentSales.view')
  @Get(':saleId/payments')
  findAllForSale(
    @Req() req: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    return this.paymentSaleService.findAllForSale(saleId, req.user.organizationId);
  }

  /**
   * POST /api/v1/sales/:saleId/payments
   * Encaisse un paiement sur une vente — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentSales.create')
  @Post(':saleId/payments')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'paymentSales.create', entity: 'PaymentSale' })
  create(
    @Req() req: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() body: unknown,
  ) {
    const result = CreatePaymentSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentSaleService.create(
      req.user.organizationId,
      req.user.id,
      saleId,
      result.data,
    );
  }

  /**
   * PATCH /api/v1/sales/payments/:id
   * Met à jour un paiement — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentSales.edit')
  @Patch('payments/:id')
  @Auditable({ action: 'paymentSales.edit', entity: 'PaymentSale' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdatePaymentSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentSaleService.update(id, req.user.organizationId, result.data);
  }

  /**
   * POST /api/v1/sales/payments/:id/send
   * Envoie le reçu d'un paiement de vente au client par email ou SMS (S32/S33, mirror exact de
   * POST /api/v1/sales/:id/send, S24) — enfile un job BullMQ traité de façon asynchrone par
   * un worker dédié (202 Accepted). Le canal est fourni dans le body (`{ channel }`).
   *
   * Réutilise la permission `paymentSales.view` plutôt qu'une nouvelle permission dédiée —
   * même décision que SaleController.send (S24).
   */
  @RequirePermission('paymentSales.view')
  @Post('payments/:id/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ action: 'paymentSales.send', entity: 'PaymentSale' })
  send(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = SendSaleSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentSaleService.send(id, req.user.organizationId, result.data.channel);
  }

  /**
   * DELETE /api/v1/sales/payments/:id
   * Supprime physiquement un paiement (204 No Content) — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentSales.delete')
  @Delete('payments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'paymentSales.delete', entity: 'PaymentSale' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.paymentSaleService.remove(id, req.user.organizationId);
  }
}
