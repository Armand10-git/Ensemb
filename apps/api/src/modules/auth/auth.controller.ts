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
import { Request } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService, type LoginResponse, type TokenPair } from './auth.service';
import { LoginSchema } from './dto/login.dto';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedUser } from './strategies/jwt.strategy';

/** Regex UUID v4 pour valider X-Organization-Id côté serveur. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RefreshRequest extends Request {
  user: AuthenticatedUser;
  body: { refreshToken: string };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /api/v1/auth/login
   * Taux limité à 10 req/min par IP (force brute).
   */
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown, @Req() req: Request): Promise<LoginResponse> {
    const result = LoginSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }

    const organizationId = this.resolveOrganizationId(req);
    return this.authService.login(result.data, organizationId);
  }

  /**
   * POST /api/v1/auth/refresh
   * Le refresh token est lu depuis le body par la stratégie jwt-refresh.
   * Taux limité pour éviter le bruteforce des refresh tokens.
   */
  @UseGuards(ThrottlerGuard, JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: RefreshRequest): Promise<TokenPair> {
    const { id, organizationId, email } = req.user;
    const oldRefreshToken = req.body.refreshToken;
    return this.authService.refresh(id, organizationId, email, oldRefreshToken);
  }

  /**
   * POST /api/v1/auth/logout
   * Révoque le refresh token en blacklist Redis.
   * Le refreshToken est obligatoire — un logout sans token ne révoque rien côté serveur.
   * Note : l'access token (durée 15 min) n'est pas révoqué — contrainte assumée du modèle
   * stateless JWT ; le client doit le supprimer localement.
   */
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: { refreshToken: string }): Promise<void> {
    if (!body.refreshToken) {
      throw new UnprocessableEntityException('refreshToken est requis pour révoquer la session.');
    }
    await this.authService.logout(body.refreshToken);
  }

  /**
   * Résout l'organizationId depuis l'en-tête X-Organization-Id.
   * Valide le format UUID. L'existence de l'organisation est vérifiée dans AuthService.
   * DETTE (T02) : à remplacer par la résolution automatique via sous-domaine (TenancyModule).
   */
  private resolveOrganizationId(req: Request): string {
    const orgId = req.headers['x-organization-id'];
    if (typeof orgId !== 'string' || !UUID_REGEX.test(orgId)) {
      throw new UnprocessableEntityException('En-tête X-Organization-Id manquant ou invalide (UUID attendu).');
    }
    return orgId;
  }
}
