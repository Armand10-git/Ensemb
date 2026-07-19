import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { RedisService } from '../../../common/redis.service';
import { PrismaService } from '../../../common/prisma.service';
import type { JwtPayload, AuthenticatedUser } from './jwt.strategy';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromBodyField('refreshToken'),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<AuthenticatedUser> {
    const token = (req.body as { refreshToken?: string }).refreshToken;
    if (!token) throw new UnauthorizedException('Refresh token manquant.');

    // Vérifie que le token n'est pas en blacklist (révoqué après logout ou rotation)
    const blacklisted = await this.redis.get(`blacklist:refresh:${token}`);
    if (blacklisted) throw new UnauthorizedException('Session révoquée.');

    // Vérifie si l'organisation a été suspendue par le staff plateforme (T08)
    const orgSuspended = await this.redis.get(`platform:org-suspended:${payload.organizationId}`);
    if (orgSuspended) throw new UnauthorizedException('Compte suspendu.');

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, organizationId: payload.organizationId, deletedAt: null },
      select: { id: true, organizationId: true, email: true, isActive: true },
    });

    if (!user) throw new UnauthorizedException('Compte introuvable.');
    if (!user.isActive) throw new UnauthorizedException('Compte désactivé.');

    return user;
  }
}
