import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import type { PlatformAdminJwtPayload } from './platform-admin.guard';

/**
 * Factory retournant un guard qui accepte uniquement les tempTokens plateforme
 * (payload.step présent) pour les étapes `allowedSteps`.
 *
 * Utilisé sur /totp/setup (step=totp-setup) et /totp/verify (mfa | totp-setup).
 * Un token complet (sans step) est rejeté — il n'a pas sa place sur ces endpoints.
 */
export function TempTokenGuard(allowedSteps: Array<'mfa' | 'totp-setup'>) {
  @Injectable()
  class TempTokenGuardClass implements CanActivate {
    // membres publics requis car la classe est exportée anonymement (TS4094)
    constructor(
      public readonly jwt: JwtService,
      public readonly config: ConfigService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest<Request & { platformAdminId?: string }>();
      const token = this.extractBearer(request);
      if (!token) throw new UnauthorizedException('Token temporaire manquant.');

      let payload: PlatformAdminJwtPayload;
      try {
        payload = await this.jwt.verifyAsync<PlatformAdminJwtPayload>(token, {
          secret: this.config.getOrThrow<string>('PLATFORM_JWT_SECRET'),
        });
      } catch {
        throw new UnauthorizedException('Token temporaire invalide.');
      }

      if (!payload.step || !allowedSteps.includes(payload.step)) {
        throw new UnauthorizedException('Token temporaire MFA requis.');
      }

      request.platformAdminId = payload.sub;
      return true;
    }

    public extractBearer(req: Request): string | null {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) return null;
      return auth.slice(7);
    }
  }

  return TempTokenGuardClass;
}
