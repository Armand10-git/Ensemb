import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { BillingService } from './billing.service';
import { SubscribeSchema } from './dto/subscribe.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * Endpoints de facturation — accès réservé aux utilisateurs authentifiés avec la permission billing.manage.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('billing.manage')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /**
   * POST /api/v1/billing/subscribe
   * Génère un lien de paiement pour la souscription ou le renouvellement d'un plan.
   * Répond 201 avec { invoiceId, paymentUrl }.
   */
  @Post('subscribe')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'BILLING_SUBSCRIBE', entity: 'Subscription' })
  async subscribe(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ invoiceId: string; paymentUrl: string }> {
    const result = SubscribeSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException('Données de souscription invalides.');
    }

    const { organizationId } = req.user;
    const { planId, period } = result.data;

    return this.billingService.createPaymentLink(organizationId, planId, period);
  }
}
