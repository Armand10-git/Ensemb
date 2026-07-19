import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { generateSecret, verifySync, generateURI } from 'otplib';
import { NobleCryptoPlugin } from '@otplib/plugin-crypto-noble';
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { EncryptionService } from '../../common/encryption.service';

/** Plugin crypto synchrone — requis par generateSync/verifySync (otplib v13). */
const CRYPTO_PLUGIN = new NobleCryptoPlugin();
const BASE32_PLUGIN = new ScureBase32Plugin();

/** TTL du refresh token plateforme en secondes (7 jours). */
const REFRESH_TTL_S = 7 * 24 * 60 * 60;

/**
 * Hash factice bcrypt (cost 12) pour l'anti-timing sur les logins avec email inconnu.
 * bcrypt.compare s'exécute toujours, rendant les réponses "email inconnu" et
 * "mot de passe incorrect" indiscernables en temps.
 */
const DUMMY_HASH = '$2b$12$tm1bnktiT7GAWx2VvNLepO3dSC7nmSTP1qKJWb4F2GA4/6xUVYD2O';

export interface PlatformTokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  tempToken: string;
  requiresMfa: boolean;
  requiresTotpSetup: boolean;
}

export interface SetupTotpResult {
  otpAuthUrl: string;
  /** Secret TOTP en clair — retourné une seule fois pour affichage QR code. */
  secret: string;
}

/**
 * Auth séparée pour le staff plateforme (PlatformAdmin).
 *
 * Séparation absolue avec l'auth tenant : JWT distincts (PLATFORM_JWT_SECRET),
 * modèle distinct (PlatformAdmin ≠ User), guard distinct.
 *
 * Flow MFA en deux étapes :
 *  1. POST /login → tempToken (step: 'mfa' | 'totp-setup', TTL 5 min)
 *  2. POST /totp/setup ou /totp/verify → tokens complets
 */
@Injectable()
export class PlatformAdminAuthService {
  private readonly logger = new Logger(PlatformAdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Première étape du login : vérifie email + mot de passe.
   * Retourne un tempToken JWT court-vécu (5 min) indiquant l'étape MFA requise.
   *
   * Anti-timing : bcrypt.compare s'exécute même si l'email est inconnu.
   * Anti-énumération : même 401 générique pour email inconnu / mauvais mdp / compte inactif.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { email } });

    const hash = admin?.password ?? DUMMY_HASH;
    const passwordMatch = await bcrypt.compare(password, hash);

    if (!admin || !passwordMatch || !admin.isActive) {
      throw new UnauthorizedException('Identifiants invalides.');
    }

    const step = admin.totpEnabled ? 'mfa' : 'totp-setup';
    const tempToken = await this.jwt.signAsync(
      { sub: admin.id, step },
      {
        secret: this.config.getOrThrow<string>('PLATFORM_JWT_SECRET'),
        expiresIn: '5m',
      },
    );

    return {
      tempToken,
      requiresMfa: admin.totpEnabled,
      requiresTotpSetup: !admin.totpEnabled,
    };
  }

  /**
   * Génère et persiste un nouveau secret TOTP pour l'admin.
   * Le secret est chiffré AES-256-GCM avant écriture en base.
   * Retourne le secret en clair une seule fois (pour affichage QR code).
   *
   * @param adminId - UUID du PlatformAdmin (extrait du tempToken step=totp-setup)
   */
  async setupTotp(adminId: string): Promise<SetupTotpResult> {
    const secret = generateSecret({ crypto: CRYPTO_PLUGIN });
    const admin = await this.prisma.platformAdmin.findUniqueOrThrow({
      where: { id: adminId },
      select: { email: true },
    });

    const encryptedSecret = this.encryption.encrypt(secret);
    await this.prisma.platformAdmin.update({
      where: { id: adminId },
      data: { totpSecret: encryptedSecret, totpEnabled: false },
    });

    const otpAuthUrl = generateURI({ issuer: 'Ensemb Platform', label: admin.email, secret });
    return { otpAuthUrl, secret };
  }

  /**
   * Vérifie un code TOTP et émet les tokens complets si correct.
   * Active définitivement le TOTP (totpEnabled = true) lors de la première vérification réussie.
   *
   * @param adminId - UUID du PlatformAdmin (extrait du tempToken)
   * @param code    - Code TOTP 6 chiffres saisi par l'admin
   */
  async verifyTotp(adminId: string, code: string): Promise<PlatformTokenPair> {
    const admin = await this.prisma.platformAdmin.findUniqueOrThrow({
      where: { id: adminId },
      select: { id: true, email: true, totpSecret: true, totpEnabled: true, isActive: true },
    });

    if (!admin.isActive) throw new UnauthorizedException('Identifiants invalides.');

    if (!admin.totpSecret) {
      throw new UnauthorizedException('TOTP non configuré. Appelez /totp/setup d\'abord.');
    }

    const secret = this.encryption.decrypt(admin.totpSecret);
    const verifyResult = verifySync({
      token: code,
      secret,
      crypto: CRYPTO_PLUGIN,
      base32: BASE32_PLUGIN,
    });
    const isValid = verifyResult.valid;

    if (!isValid) {
      this.logger.warn(`Échec TOTP pour PlatformAdmin ${adminId}`);
      throw new UnauthorizedException('Code TOTP invalide.');
    }

    if (!admin.totpEnabled) {
      await this.prisma.platformAdmin.update({
        where: { id: adminId },
        data: { totpEnabled: true },
      });
    }

    return this.generateTokens(adminId, admin.email);
  }

  /**
   * Rotation du refresh token plateforme.
   * Vérifie la signature du refresh token, blackliste l'ancien,
   * vérifie l'isActive et émet un nouveau access token.
   *
   * @param rawRefreshToken - Token JWT refresh brut (depuis le corps de la requête)
   */
  async refresh(rawRefreshToken: string): Promise<{ accessToken: string }> {
    const platformSecret = this.config.getOrThrow<string>('PLATFORM_JWT_SECRET');

    let payload: { sub: string; email: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(rawRefreshToken, {
        secret: platformSecret,
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalide.');
    }

    const blacklisted = await this.redis.get(`platform:refresh:${rawRefreshToken}`);
    if (blacklisted) throw new UnauthorizedException('Session révoquée.');

    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: payload.sub },
      select: { isActive: true },
    });
    if (!admin || !admin.isActive) throw new UnauthorizedException('Identifiants invalides.');

    await this.redis.setNx(`platform:refresh:${rawRefreshToken}`, '1', REFRESH_TTL_S);

    const accessToken = await this.jwt.signAsync(
      { sub: payload.sub, email: payload.email },
      { secret: platformSecret, expiresIn: '15m' },
    );
    return { accessToken };
  }

  /**
   * Révoque le refresh token plateforme (blacklist Redis).
   * Vérifie que le token appartient à l'admin appelant pour éviter
   * qu'un admin invalide la session d'un autre.
   *
   * @param refreshToken  - Token JWT brut à révoquer
   * @param callerAdminId - UUID de l'admin authentifié (extrait du guard)
   */
  async logout(refreshToken: string, callerAdminId: string): Promise<void> {
    const payload = this.jwt.decode(refreshToken) as { sub?: string } | null;
    if (!payload?.sub || payload.sub !== callerAdminId) {
      throw new UnauthorizedException('Token non autorisé.');
    }
    await this.redis.set(`platform:refresh:${refreshToken}`, '1', REFRESH_TTL_S);
  }

  private async generateTokens(adminId: string, email: string): Promise<PlatformTokenPair> {
    const secret = this.config.getOrThrow<string>('PLATFORM_JWT_SECRET');
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync({ sub: adminId, email }, { secret, expiresIn: '15m' }),
      this.jwt.signAsync({ sub: adminId, email }, { secret, expiresIn: '7d' }),
    ]);
    return { accessToken, refreshToken };
  }
}
