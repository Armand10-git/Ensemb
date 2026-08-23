import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { PaymentGatewayCredentialService } from './payment-gateway-credential.service';
import { PaymentGatewayCredentialSchema } from './dto/payment-gateway-credential.dto';
import type { PaymentGatewayCredentialPublicDto } from './dto/payment-gateway-credential.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * Endpoint de configuration de l'agrégateur de paiement par organisation (S31).
 * PUT /api/v1/organizations/settings/payment-gateway — idempotent (crée ou remplace).
 */
@Controller('organizations')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('organization.settings.edit')
export class PaymentGatewayCredentialController {
  constructor(private readonly paymentGatewayCredentialService: PaymentGatewayCredentialService) {}

  /**
   * PUT /api/v1/organizations/settings/payment-gateway
   * Configure ou remplace les identifiants d'agrégateur de paiement de l'organisation
   * authentifiée (apiKey/webhookSecret chiffrés avant écriture).
   */
  @Put('settings/payment-gateway')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: 'ORGANIZATION_PAYMENT_GATEWAY_UPDATE', entity: 'PaymentGatewayCredential' })
  async upsert(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<PaymentGatewayCredentialPublicDto> {
    const result = PaymentGatewayCredentialSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException("Configuration de l'agrégateur de paiement invalide.");
    }
    return this.paymentGatewayCredentialService.upsert(req.user.organizationId, result.data);
  }
}
