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
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { SmtpServerService } from './smtp-server.service';
import { SmtpServerSchema } from './dto/smtp-server.dto';
import type { SmtpServerPublicDto } from './dto/smtp-server.dto';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

interface AuthRequest extends Request {
  user: AuthenticatedUser;
}

/**
 * Endpoint de configuration SMTP par organisation.
 * PUT /api/v1/organizations/smtp — idempotent (crée ou remplace).
 */
@Controller('organizations')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('organization.settings.edit')
export class SmtpServerController {
  constructor(private readonly smtpServerService: SmtpServerService) {}

  /**
   * PUT /api/v1/organizations/smtp
   * Configure ou remplace le serveur SMTP de l'organisation authentifiée.
   */
  @Put('smtp')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: 'ORGANIZATION_SMTP_UPDATE', entity: 'SmtpServer' })
  async upsert(
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ): Promise<SmtpServerPublicDto> {
    const result = SmtpServerSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException('Configuration SMTP invalide.');
    }
    return this.smtpServerService.upsert(req.user.organizationId, result.data);
  }
}
