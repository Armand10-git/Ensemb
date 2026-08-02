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
 * Endpoints des paiements (remboursements) enregistrés sur un retour de vente (S26 —
 * §18.5). Mirror exact de PaymentSaleController.
 *
 * Coexiste avec SaleReturnController (@Controller('sale-returns')) sur le même préfixe
 * — les patterns de routes ne collisionnent pas (':id' vs ':saleReturnId/payments'),
 * exactement comme PaymentSaleController coexiste avec SaleController sur 'sales'.
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId et userId sont toujours extraits de req.user — jamais de l'URL/body
 * (anti-IDOR). Le discriminant de parent (saleReturnId) est déterminé par l'URL,
 * jamais par le corps de la requête. Chaque écriture recalcule
 * SaleReturn.paidAmount/paymentStatus côté service.
 *
 * Routes :
 *   GET    /api/v1/sale-returns/:saleReturnId/payments  → historique chronologique
 *   POST   /api/v1/sale-returns/:saleReturnId/payments  → 201 (enregistre un remboursement)
 *   PATCH  /api/v1/sale-returns/payments/:id            → 200
 *   DELETE /api/v1/sale-returns/payments/:id            → 204 (suppression physique, cf. service)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('sale-returns')
export class PaymentSaleReturnController {
  constructor(private readonly paymentReturnService: PaymentReturnService) {}

  /**
   * GET /api/v1/sale-returns/:saleReturnId/payments
   * Retourne l'historique chronologique des paiements d'un retour de vente.
   */
  @RequirePermission('paymentReturns.view')
  @Get(':saleReturnId/payments')
  findAllForSaleReturn(
    @Req() req: AuthenticatedRequest,
    @Param('saleReturnId', ParseUUIDPipe) saleReturnId: string,
  ) {
    return this.paymentReturnService.findAllForSaleReturn(
      saleReturnId,
      req.user.organizationId,
    );
  }

  /**
   * POST /api/v1/sale-returns/:saleReturnId/payments
   * Enregistre un remboursement sur un retour de vente — recalcule paidAmount/paymentStatus.
   */
  @RequirePermission('paymentReturns.create')
  @Post(':saleReturnId/payments')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'paymentReturns.create', entity: 'PaymentReturn' })
  create(
    @Req() req: AuthenticatedRequest,
    @Param('saleReturnId', ParseUUIDPipe) saleReturnId: string,
    @Body() body: unknown,
  ) {
    const result = CreatePaymentReturnSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.paymentReturnService.createForSaleReturn(
      req.user.organizationId,
      req.user.id,
      saleReturnId,
      result.data,
    );
  }

  /**
   * PATCH /api/v1/sale-returns/payments/:id
   * Met à jour un paiement de retour de vente — recalcule paidAmount/paymentStatus.
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
   * DELETE /api/v1/sale-returns/payments/:id
   * Supprime physiquement un paiement de retour de vente (204 No Content) —
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
