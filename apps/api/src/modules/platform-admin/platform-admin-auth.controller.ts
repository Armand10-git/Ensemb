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
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { PlatformAdminAuthService } from './platform-admin-auth.service';
import { PlatformAdminGuard, AuthenticatedPlatformAdmin } from './platform-admin.guard';
import { TempTokenGuard } from './platform-admin-temp-token.guard';
import {
  PlatformAdminLoginSchema,
  type PlatformAdminLoginDto,
} from './dto/platform-admin-login.dto';
import {
  PlatformAdminTotpVerifySchema,
  type PlatformAdminTotpVerifyDto,
} from './dto/platform-admin-totp.dto';
import {
  PlatformAdminRefreshSchema,
} from './dto/platform-admin-refresh.dto';

const SetupGuard = TempTokenGuard(['totp-setup']);
const VerifyGuard = TempTokenGuard(['mfa', 'totp-setup']);

/**
 * Endpoints d'authentification plateforme — séparés de l'auth tenant.
 * Préfixe : /api/v1/platform-admin/auth
 *
 * Flow MFA deux étapes :
 *  1. POST /login → tempToken
 *  2a. POST /totp/setup (si first login) → secret + otpAuthUrl
 *  2b. POST /totp/verify → accessToken + refreshToken
 */
@Controller('platform-admin/auth')
export class PlatformAdminAuthController {
  constructor(private readonly authService: PlatformAdminAuthService) {}

  /**
   * Étape 1 : login email + mot de passe.
   * Retourne un tempToken (5 min) — jamais les tokens complets.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() body: unknown) {
    const result = PlatformAdminLoginSchema.safeParse(body);
    if (!result.success) throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    const dto = result.data as PlatformAdminLoginDto;
    return this.authService.login(dto.email, dto.password);
  }

  /**
   * Génère un secret TOTP et l'URL otpauth pour QR code.
   * Accessible uniquement avec un tempToken step=totp-setup.
   */
  @Post('totp/setup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SetupGuard)
  async setupTotp(@Req() req: Request & { platformAdminId?: string }) {
    return this.authService.setupTotp(req.platformAdminId as string);
  }

  /**
   * Vérifie le code TOTP et émet les tokens complets si correct.
   * Accessible avec un tempToken step=mfa ou step=totp-setup.
   */
  @Post('totp/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(VerifyGuard)
  async verifyTotp(
    @Req() req: Request & { platformAdminId?: string },
    @Body() body: unknown,
  ) {
    const result = PlatformAdminTotpVerifySchema.safeParse(body);
    if (!result.success) throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    const dto = result.data as PlatformAdminTotpVerifyDto;
    return this.authService.verifyTotp(req.platformAdminId as string, dto.code);
  }

  /**
   * Rotation du refresh token plateforme.
   * Retourne un nouveau access token.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async refresh(@Body() body: unknown) {
    const result = PlatformAdminRefreshSchema.safeParse(body);
    if (!result.success) throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    return this.authService.refresh(result.data.refreshToken);
  }

  /** Révoque le refresh token (blacklist Redis). */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PlatformAdminGuard)
  async logout(
    @Body() body: unknown,
    @Req() req: Request & { platformAdmin?: AuthenticatedPlatformAdmin },
  ) {
    const result = PlatformAdminRefreshSchema.safeParse(body);
    if (!result.success) throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    const callerAdminId = (req.platformAdmin as AuthenticatedPlatformAdmin).id;
    await this.authService.logout(result.data.refreshToken, callerAdminId);
  }
}
