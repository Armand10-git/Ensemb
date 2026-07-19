import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../common/prisma.service';

export interface JwtPayload {
  sub: string;
  organizationId: string;
  email: string;
}

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string;
  isActive: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, organizationId: payload.organizationId, deletedAt: null },
      select: { id: true, organizationId: true, email: true, isActive: true },
    });

    if (!user) throw new UnauthorizedException('Compte introuvable.');
    if (!user.isActive) throw new UnauthorizedException('Compte désactivé.');

    return user;
  }
}
