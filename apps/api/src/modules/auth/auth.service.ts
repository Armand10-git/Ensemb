import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import type { LoginDto } from './dto/login.dto';
import type { JwtPayload } from './strategies/jwt.strategy';

/** TTL du refresh token en secondes (7 jours). */
const REFRESH_TTL_S = 7 * 24 * 60 * 60;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResponse extends TokenPair {
  permissions: string[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Authentifie un utilisateur dans le contexte d'une organisation.
   * Vérifie email, mot de passe et isActive.
   * Retourne les tokens JWT et la liste des permissions.
   */
  async login(dto: LoginDto, organizationId: string): Promise<LoginResponse> {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, organizationId, deletedAt: null },
      include: {
        roles: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    });

    // Réponse neutre — ne pas révéler si l'email existe
    if (!user) throw new UnauthorizedException('Identifiants invalides.');

    const passwordMatch = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatch) throw new UnauthorizedException('Identifiants invalides.');

    if (!user.isActive) {
      throw new UnauthorizedException('Ce compte est désactivé. Contactez votre administrateur.');
    }

    const permissions = [
      ...new Set(
        user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.name)),
      ),
    ];

    const tokens = await this.generateTokens({
      sub: user.id,
      organizationId: user.organizationId,
      email: user.email,
    });

    return { ...tokens, permissions };
  }

  /**
   * Émet un nouveau access token à partir d'un refresh token valide.
   * Rotation : l'ancien refresh token est révoqué, un nouveau est émis.
   */
  async refresh(userId: string, organizationId: string, email: string, oldRefreshToken: string): Promise<TokenPair> {
    // Révoque l'ancien refresh token (rotation)
    await this.redis.set(`blacklist:refresh:${oldRefreshToken}`, '1', REFRESH_TTL_S);

    return this.generateTokens({ sub: userId, organizationId, email });
  }

  /**
   * Révoque le refresh token (blacklist Redis) pour déconnecter la session.
   */
  async logout(refreshToken: string): Promise<void> {
    await this.redis.set(`blacklist:refresh:${refreshToken}`, '1', REFRESH_TTL_S);
  }

  private async generateTokens(payload: JwtPayload): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: '15m',
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);

    return { accessToken, refreshToken };
  }
}
