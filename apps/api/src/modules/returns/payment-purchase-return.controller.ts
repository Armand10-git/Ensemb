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
import { PaymentReturnService } from './payment-return.service';
import { CreatePaymentReturnSchema } from './dto/create-payment-return.dto';
import { UpdatePaymentReturnSchema } from './dto/update-payment-return.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * Endpoints des paiements (remboursements) enregistrés sur un retour d'achat
 * fournisseur (S26 — §18.5). Mirror exact de PaymentSaleController /
 * PaymentSaleReturnController, côté achats.
 *
 * Coexiste avec PurchaseReturnController (@Controller('purchase-returns')) sur le
 * même préfixe — les patterns de routes ne collisionnent pas (':id' vs
 * ':purchaseReturnId/payments').
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId et userId sont toujours extraits de req.user — jamais de l'URL/body
 * (anti-IDOR). Le discriminant de parent (purchaseReturnId) est déterminé par l'URL,
 * jamais par le corps de la requête. Chaque écriture recalcule
 * PurchaseReturn.paidAmount/paymentStatus côté service.
 *
 * Routes :
 *   GET    /api/v1/purchase-returns/:purchaseReturnId/payments  → historique chronologique
 *   POST   /api/v1/purchase-returns/:purchaseReturnId/payments  → 201 (enregistre un remboursement)
 *   PATCH  /api/v1/purchase-returns/payments/:id                → 200
 *   DELETE /api/v1/purchase-returns/payments/:id                → 204 (suppression physique, cf. service)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('purchase-returns')
export class PaymentPurchaseReturnController {
  constructor(private readonly paymentReturnService: PaymentReturnService) {}

  /**
   * GET /api/v1/purchase-returns/:purchaseReturnId/payments
   * Retourne l'historique chronologique des paiements d'un retour d'achat.
   */
  @RequirePermission('paymentReturns.view')
  @Get(':purchaseReturnId/payments')
  findAllForPurchaseReturn(
    @Req() req: AuthenticatedRequest,
    @Param('purchaseReturnId', ParseUUIDPipe) purchaseReturnId: string,
  ) {
    return this.paymentReturnService.findAllForPurchaseReturn(
      purchaseReturnId,
      req.user.organizationId,
    );
  }

  /**
   * POST /api/v1/purchase-returns/:purchaseReturnId/payments
   * Enregistre un remboursement sur un retour d'achat — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentReturns.create')
  @Post(':purchaseReturnId/payments')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'paymentReturns.create', entity: 'PaymentReturn' })
  create(
    @Req() req: AuthenticatedRequest,
    @Param('purchaseReturnId', ParseUUIDPipe) purchaseReturnId: string,
    @Body() body: unknown,
  ) {
    const result = CreatePaymentReturnSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentReturnService.createForPurchaseReturn(
      req.user.organizationId,
      req.user.id,
      purchaseReturnId,
      result.data,
    );
  }

  /**
   * PATCH /api/v1/purchase-returns/payments/:id
   * Met à jour un paiement de retour d'achat — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentReturns.edit')
  @Patch('payments/:id')
  @Auditable({ action: 'paymentReturns.edit', entity: 'PaymentReturn' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdatePaymentReturnSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentReturnService.update(id, req.user.organizationId, result.data);
  }

  /**
   * DELETE /api/v1/purchase-returns/payments/:id
   * Supprime physiquement un paiement de retour d'achat (204 No Content) —
   * recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentReturns.delete')
  @Delete('payments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'paymentReturns.delete', entity: 'PaymentReturn' })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.paymentReturnService.remove(id, req.user.organizationId);
  }
}
