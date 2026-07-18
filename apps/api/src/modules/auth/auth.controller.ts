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
import { LoginSchema, type LoginDto } from './dto/login.dto';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedUser } from './strategies/jwt.strategy';

interface RefreshRequest extends Request {
  user: AuthenticatedUser;
  body: { refreshToken: string };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /api/v1/auth/login
   * Taux limité par @nestjs/throttler (guard global ou local).
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
    return this.authService.login(result.data as LoginDto, organizationId);
  }

  /**
   * POST /api/v1/auth/refresh
   * Le refresh token est lu depuis le body par la stratégie jwt-refresh.
   */
  @UseGuards(JwtRefreshGuard)
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
   */
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: { refreshToken?: string }): Promise<void> {
    if (body.refreshToken) {
      await this.authService.logout(body.refreshToken);
    }
  }

  /**
   * Résout l'organizationId depuis l'en-tête X-Organization-Id (provisoire).
   * En S06, TenancyModule n'existe pas encore — le client envoie l'id directement.
   * À remplacer par la résolution par sous-domaine en T02.
   */
  private resolveOrganizationId(req: Request): string {
    const orgId = req.headers['x-organization-id'];
    if (typeof orgId !== 'string' || !orgId) {
      throw new UnprocessableEntityException('En-tête X-Organization-Id manquant.');
    }
    return orgId;
  }
}
