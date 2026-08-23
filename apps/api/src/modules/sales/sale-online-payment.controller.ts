import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { SaleOnlinePaymentService } from './sale-online-payment.service';
import { CreateOnlinePaymentSchema } from './dto/create-online-payment.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * Endpoint d'initiation d'un paiement en ligne (agrégateur — CARD/ORANGE_MONEY/MTN_MOMO)
 * sur une vente classique hors-POS (S31, §17 point V).
 *
 * Protégé JwtAuthGuard + PermissionGuard, permission réutilisée `paymentSales.create`
 * (pas de nouvelle permission — même patron que PaymentSaleController, S20).
 * organizationId/userId sont toujours extraits de req.user, jamais de l'URL/body (anti-IDOR).
 *
 * Routes :
 *   POST /api/v1/sales/:saleId/payments/online → 201 { intentId, paymentLink, expiresAt }
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('sales')
export class SaleOnlinePaymentController {
  constructor(private readonly saleOnlinePaymentService: SaleOnlinePaymentService) {}

  /**
   * POST /api/v1/sales/:saleId/payments/online
   * Initie un paiement en ligne sur une vente — crée l'OnlinePaymentIntent (PENDING),
   * retourne le lien de paiement hébergé par l'agrégateur.
   */
  @RequirePermission('paymentSales.create')
  @Post(':saleId/payments/online')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'paymentSales.create', entity: 'OnlinePaymentIntent' })
  initiate(
    @Req() req: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() body: unknown,
  ) {
    const result = CreateOnlinePaymentSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.saleOnlinePaymentService.initiate(
      req.user.organizationId,
      saleId,
      result.data.amount,
    );
  }
}
