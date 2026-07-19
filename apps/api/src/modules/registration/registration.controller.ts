import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Auditable } from '../audit/auditable.decorator';
import { RegistrationService, type RegistrationResult } from './registration.service';
import { RegisterOrganizationSchema } from './dto/register-organization.dto';

/**
 * Endpoints publics d'inscription — exemptés du middleware tenant (/api/v1/public/(.*)).
 * Aucune authentification requise. Rate limiting strict contre la force brute et l'abus.
 */
@Controller('public/organizations')
export class RegistrationController {
  constructor(private readonly registrationService: RegistrationService) {}

  /**
   * GET /api/v1/public/organizations/check-subdomain/:subdomain
   * Vérifie la disponibilité d'un sous-domaine.
   * Réponse intentionnellement neutre — ne révèle pas l'existence d'une organisation.
   * Taux limité à 20 req/min pour la saisie en direct côté client.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('check-subdomain/:subdomain')
  async checkSubdomain(
    @Param('subdomain') subdomain: string,
  ): Promise<{ available: boolean }> {
    return this.registrationService.checkSubdomainAvailability(subdomain);
  }

  /**
   * POST /api/v1/public/organizations/register
   * Crée une nouvelle organisation avec son premier administrateur.
   * Transaction atomique : aucune création partielle possible.
   * Taux limité à 5 req/min pour limiter les inscriptions abusives.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'ORGANIZATION_REGISTER', entity: 'organization' })
  async register(@Body() body: unknown): Promise<RegistrationResult> {
    const result = RegisterOrganizationSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }

    return this.registrationService.register(result.data);
  }
}
