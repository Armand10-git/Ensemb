import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { PlatformAdminAuthService } from '../platform-admin-auth.service';
import { PrismaService } from '../../../common/prisma.service';
import { RedisService } from '../../../common/redis.service';
import { EncryptionService } from '../../../common/encryption.service';

// otplib v13 ESM pur — on mock le module entier pour les tests unitaires.
// Les fonctions réelles sont testées dans le test e2e (platform-admin.e2e.spec.ts).
jest.mock('otplib', () => ({
  generateSecret: jest.fn().mockReturnValue('MOCKED_SECRET'),
  generateSync: jest.fn().mockReturnValue('123456'),
  verifySync: jest.fn().mockReturnValue({ valid: true }),
  generateURI: jest.fn().mockReturnValue('otpauth://totp/Ensemb%20Platform:admin@test?secret=MOCKED&issuer=Ensemb%20Platform'),
}));
jest.mock('@otplib/plugin-crypto-noble', () => ({
  NobleCryptoPlugin: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@otplib/plugin-base32-scure', () => ({
  ScureBase32Plugin: jest.fn().mockImplementation(() => ({})),
}));

import { verifySync } from 'otplib';

const PLATFORM_JWT_SECRET = 'test-platform-secret';

let HASHED_PASSWORD: string;

beforeAll(async () => {
  HASHED_PASSWORD = await bcrypt.hash('correct-password', 12);
});

const mockAdmin = () => ({
  id: 'admin-uuid',
  email: 'admin@ensemb.platform',
  password: HASHED_PASSWORD,
  totpSecret: null,
  totpEnabled: false,
  isActive: true,
});

const mockPrisma = {
  platformAdmin: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
  },
};

const mockJwt = {
  signAsync: jest.fn().mockResolvedValue('signed-token'),
  verifyAsync: jest.fn(),
};

const mockConfig = {
  getOrThrow: jest.fn().mockReturnValue(PLATFORM_JWT_SECRET),
};

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn(),
  setNx: jest.fn().mockResolvedValue(true),
};

const ENCRYPTED_SECRET = 'iv:tag:cipher';
const PLAIN_SECRET = 'MOCKED_SECRET';

const mockEncryption = {
  encrypt: jest.fn().mockReturnValue(ENCRYPTED_SECRET),
  decrypt: jest.fn().mockReturnValue(PLAIN_SECRET),
};

describe('PlatformAdminAuthService', () => {
  let service: PlatformAdminAuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Rétablir le mock verifySync à "valide" par défaut entre tests
    (verifySync as jest.Mock).mockReturnValue({ valid: true });

    const module = await Test.createTestingModule({
      providers: [
        PlatformAdminAuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: RedisService, useValue: mockRedis },
        { provide: EncryptionService, useValue: mockEncryption },
      ],
    }).compile();
    service = module.get(PlatformAdminAuthService);
  });

  describe('login()', () => {
    it('retourne 401 générique si email inconnu (anti-timing : bcrypt.compare quand même exécuté)', async () => {
      mockPrisma.platformAdmin.findUnique.mockResolvedValue(null);
      await expect(service.login('unknown@x.com', 'any')).rejects.toThrow(UnauthorizedException);
    });

    it('retourne 401 générique si mot de passe incorrect', async () => {
      mockPrisma.platformAdmin.findUnique.mockResolvedValue(mockAdmin());
      await expect(service.login(mockAdmin().email, 'wrong-password')).rejects.toThrow(UnauthorizedException);
    });

    it('retourne 401 générique si compte inactif (anti-énumération)', async () => {
      mockPrisma.platformAdmin.findUnique.mockResolvedValue({ ...mockAdmin(), isActive: false });
      await expect(service.login(mockAdmin().email, 'correct-password')).rejects.toThrow(UnauthorizedException);
    });

    it('retourne tempToken avec step=totp-setup si TOTP non configuré', async () => {
      mockPrisma.platformAdmin.findUnique.mockResolvedValue(mockAdmin());
      const result = await service.login(mockAdmin().email, 'correct-password');
      expect(result.requiresTotpSetup).toBe(true);
      expect(result.requiresMfa).toBe(false);
      expect(result.tempToken).toBe('signed-token');
      const signCall = mockJwt.signAsync.mock.calls[0] as [{ sub: string; step: string }, object];
      expect(signCall[0].step).toBe('totp-setup');
    });

    it('retourne tempToken avec step=mfa si TOTP activé', async () => {
      mockPrisma.platformAdmin.findUnique.mockResolvedValue({ ...mockAdmin(), totpEnabled: true, totpSecret: ENCRYPTED_SECRET });
      const result = await service.login(mockAdmin().email, 'correct-password');
      expect(result.requiresMfa).toBe(true);
      expect(result.requiresTotpSetup).toBe(false);
      const signCall = mockJwt.signAsync.mock.calls[0] as [{ sub: string; step: string }, object];
      expect(signCall[0].step).toBe('mfa');
    });
  });

  describe('setupTotp()', () => {
    it('chiffre le secret avant écriture en base (jamais en clair)', async () => {
      mockPrisma.platformAdmin.findUniqueOrThrow.mockResolvedValue({ email: mockAdmin().email });
      mockPrisma.platformAdmin.update.mockResolvedValue({});

      const result = await service.setupTotp('admin-uuid');

      expect(mockEncryption.encrypt).toHaveBeenCalledTimes(1);
      const updateCall = mockPrisma.platformAdmin.update.mock.calls[0] as [{ data: { totpSecret: string } }];
      expect(updateCall[0].data.totpSecret).toBe(ENCRYPTED_SECRET);
      expect(result.secret).toBeDefined();
      expect(result.otpAuthUrl).toContain('otpauth://');
    });
  });

  describe('verifyTotp()', () => {
    it('émet access + refresh tokens si code correct', async () => {
      (verifySync as jest.Mock).mockReturnValue({ valid: true });
      mockPrisma.platformAdmin.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-uuid',
        email: mockAdmin().email,
        totpSecret: ENCRYPTED_SECRET,
        totpEnabled: true,
        isActive: true,
      });
      mockPrisma.platformAdmin.update.mockResolvedValue({});
      mockJwt.signAsync.mockResolvedValue('full-token');

      const result = await service.verifyTotp('admin-uuid', '123456');

      expect(result.accessToken).toBe('full-token');
      expect(result.refreshToken).toBe('full-token');
      expect(mockEncryption.decrypt).toHaveBeenCalledWith(ENCRYPTED_SECRET);
    });

    it('retourne 401 si code TOTP incorrect', async () => {
      (verifySync as jest.Mock).mockReturnValue({ valid: false });
      mockPrisma.platformAdmin.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-uuid',
        email: mockAdmin().email,
        totpSecret: ENCRYPTED_SECRET,
        totpEnabled: true,
        isActive: true,
      });
      await expect(service.verifyTotp('admin-uuid', '000000')).rejects.toThrow(UnauthorizedException);
    });

    it('active totpEnabled=true lors de la première vérification réussie', async () => {
      (verifySync as jest.Mock).mockReturnValue({ valid: true });
      mockPrisma.platformAdmin.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-uuid',
        email: mockAdmin().email,
        totpSecret: ENCRYPTED_SECRET,
        totpEnabled: false,
        isActive: true,
      });
      mockPrisma.platformAdmin.update.mockResolvedValue({});

      await service.verifyTotp('admin-uuid', '123456');

      const updateCall = mockPrisma.platformAdmin.update.mock.calls[0] as [{ data: { totpEnabled: boolean } }];
      expect(updateCall[0].data.totpEnabled).toBe(true);
    });
  });

  describe('refresh()', () => {
    it('retourne un nouvel accessToken si refresh token valide', async () => {
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'admin-uuid', email: 'admin@ensemb.platform' });
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.platformAdmin.findUnique.mockResolvedValue({ isActive: true });
      mockJwt.signAsync.mockResolvedValue('new-access-token');

      const result = await service.refresh('valid-refresh');

      expect(result.accessToken).toBe('new-access-token');
    });

    it('retourne 401 si refresh token blacklisté', async () => {
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'admin-uuid', email: 'a@b.com' });
      mockRedis.get.mockResolvedValue('1');

      await expect(service.refresh('revoked-token')).rejects.toThrow(UnauthorizedException);
    });
  });
});
