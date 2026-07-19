import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../../common/prisma.service';

export interface PlatformAdminJwtPayload {
  sub: string;
  email: string;
  /** Présent uniquement dans un tempToken MFA — le token n'est PAS un token complet. */
  step?: 'mfa' | 'totp-setup';
  iat?: number;
  exp?: number;
}

/** Contexte injecté dans req.platformAdmin par le guard. */
export interface AuthenticatedPlatformAdmin {
  id: string;
  email: string;
}

/**
 * Guard JWT pour les endpoints PlatformAdmin.
 *
 * Séparation absolue avec JwtAuthGuard tenant :
 * - Vérifie avec PLATFORM_JWT_SECRET (jamais JWT_SECRET)
 * - Rejette les tempTokens MFA (payload.step présent)
 * - Rejette si PlatformAdmin.isActive = false
 *
 * N'utilise PAS PassportStrategy — guard manuel pour un contrôle total.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { platformAdmin?: AuthenticatedPlatformAdmin }>();
    const token = this.extractBearer(request);

    if (!token) throw new UnauthorizedException('Token manquant.');

    let payload: PlatformAdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<PlatformAdminJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('PLATFORM_JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Token invalide.');
    }

    // Un tempToken MFA (step présent) ne donne accès à aucun endpoint protégé
    if (payload.step) {
      throw new UnauthorizedException('Token temporaire MFA non autorisé ici.');
    }

    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, isActive: true },
    });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Accès refusé.');
    }

    request.platformAdmin = { id: admin.id, email: admin.email };
    return true;
  }

  private extractBearer(req: Request): string | null {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    return auth.slice(7);
  }
}
