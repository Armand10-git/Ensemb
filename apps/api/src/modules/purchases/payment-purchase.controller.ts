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
import { PaymentPurchaseService } from './payment-purchase.service';
import { CreatePaymentSchema } from './dto/create-payment.dto';
import { UpdatePaymentSchema } from './dto/update-payment.dto';
import { SendPurchaseSchema } from './dto/send-purchase.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * Endpoints des paiements d'achats fournisseurs (S25 — Bloc F, §18.7).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId et userId sont toujours extraits de req.user — jamais de l'URL/body
 * (anti-IDOR). Chaque écriture recalcule Purchase.paidAmount/paymentStatus côté service.
 *
 * Routes :
 *   GET    /api/v1/purchases/:purchaseId/payments  → historique chronologique des paiements
 *   POST   /api/v1/purchases/:purchaseId/payments  → 201 (encaisse un paiement)
 *   PATCH  /api/v1/purchases/payments/:id          → 200
 *   POST   /api/v1/purchases/payments/:id/send     → 202 (S32/S33 — envoi asynchrone du reçu par email/SMS)
 *   DELETE /api/v1/purchases/payments/:id          → 204 (suppression physique, cf. service)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('purchases')
export class PaymentPurchaseController {
  constructor(private readonly paymentPurchaseService: PaymentPurchaseService) {}

  /**
   * GET /api/v1/purchases/:purchaseId/payments
   * Retourne l'historique chronologique des paiements d'un achat.
   */
  @RequirePermission('paymentPurchases.view')
  @Get(':purchaseId/payments')
  findAllForPurchase(
    @Req() req: AuthenticatedRequest,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
  ) {
    return this.paymentPurchaseService.findAllForPurchase(purchaseId, req.user.organizationId);
  }

  /**
   * POST /api/v1/purchases/:purchaseId/payments
   * Verse un paiement sur un achat — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentPurchases.create')
  @Post(':purchaseId/payments')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'paymentPurchases.create', entity: 'PaymentPurchase' })
  create(
    @Req() req: AuthenticatedRequest,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Body() body: unknown,
  ) {
    const result = CreatePaymentSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentPurchaseService.create(
      req.user.organizationId,
      req.user.id,
      purchaseId,
      result.data,
    );
  }

  /**
   * PATCH /api/v1/purchases/payments/:id
   * Met à jour un paiement — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentPurchases.edit')
  @Patch('payments/:id')
  @Auditable({ action: 'paymentPurchases.edit', entity: 'PaymentPurchase' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdatePaymentSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentPurchaseService.update(id, req.user.organizationId, result.data);
  }

  /**
   * POST /api/v1/purchases/payments/:id/send
   * Envoie le reçu d'un paiement d'achat au fournisseur par email ou SMS (S32/S33, mirror
   * exact de POST /api/v1/sales/payments/:id/send) — enfile un job BullMQ traité de façon
   * asynchrone par un worker dédié (202 Accepted). Le canal est fourni dans le body (`{ channel }`).
   *
   * Réutilise la permission `paymentPurchases.view` plutôt qu'une nouvelle permission dédiée.
   */
  @RequirePermission('paymentPurchases.view')
  @Post('payments/:id/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ action: 'paymentPurchases.send', entity: 'PaymentPurchase' })
  send(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = SendPurchaseSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentPurchaseService.send(id, req.user.organizationId, result.data.channel);
  }

  /**
   * DELETE /api/v1/purchases/payments/:id
   * Supprime physiquement un paiement (204 No Content) — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentPurchases.delete')
  @Delete('payments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'paymentPurchases.delete', entity: 'PaymentPurchase' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.paymentPurchaseService.remove(id, req.user.organizationId);
  }
}
