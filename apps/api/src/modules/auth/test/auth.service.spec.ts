import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../../common/prisma.service';
import { RedisService } from '../../../common/redis.service';

/**
 * Tests unitaires AuthService — logique metier uniquement (mocks).
 */

const HASHED_PASSWORD = bcrypt.hashSync('CorrectPass!1', 10);

const MOCK_USER = {
  id: 'user-uuid',
  organizationId: 'org-uuid',
  email: 'admin@demo.ensemb.cm',
  password: HASHED_PASSWORD,
  isActive: true,
  deletedAt: null,
  roles: [
    {
      role: {
        permissions: [
          { permission: { name: 'sales.view' } },
          { permission: { name: 'pos.access' } },
        ],
      },
    },
  ],
};

const makePrismaMock = (userOverride?: Partial<typeof MOCK_USER> | null) => ({
  user: {
    findFirst: jest.fn().mockResolvedValue(
      userOverride === null ? null : { ...MOCK_USER, ...userOverride },
    ),
  },
});

const makeRedisMock = () => ({
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(undefined),
});

const makeJwtMock = () => ({
  signAsync: jest.fn().mockResolvedValue('signed-token'),
});

const makeConfigMock = () => ({
  getOrThrow: jest.fn().mockReturnValue('test-secret'),
});

async function buildService(
  prismaMock: ReturnType<typeof makePrismaMock>,
  redisMock: ReturnType<typeof makeRedisMock>,
) {
  const module = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: JwtService, useValue: makeJwtMock() },
      { provide: ConfigService, useValue: makeConfigMock() },
      { provide: RedisService, useValue: redisMock },
    ],
  }).compile();

  return module.get<AuthService>(AuthService);
}

describe('AuthService.login', () => {
  it('retourne les tokens et permissions pour des identifiants valides', async () => {
    const service = await buildService(makePrismaMock(), makeRedisMock());

    const result = await service.login(
      { email: 'admin@demo.ensemb.cm', password: 'CorrectPass!1' },
      'org-uuid',
    );

    expect(result.accessToken).toBe('signed-token');
    expect(result.refreshToken).toBe('signed-token');
    expect(result.permissions).toEqual(expect.arrayContaining(['sales.view', 'pos.access']));
  });

  it('leve UnauthorizedException si utilisateur inexistant', async () => {
    const service = await buildService(makePrismaMock(null), makeRedisMock());

    await expect(
      service.login({ email: 'inconnu@x.cm', password: 'any' }, 'org-uuid'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('leve UnauthorizedException si mot de passe incorrect', async () => {
    const service = await buildService(makePrismaMock(), makeRedisMock());

    await expect(
      service.login({ email: 'admin@demo.ensemb.cm', password: 'WrongPass!' }, 'org-uuid'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('leve UnauthorizedException si isActive = false', async () => {
    const service = await buildService(makePrismaMock({ isActive: false }), makeRedisMock());

    await expect(
      service.login({ email: 'admin@demo.ensemb.cm', password: 'CorrectPass!1' }, 'org-uuid'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('deduplique les permissions issues de plusieurs roles', async () => {
    const userWithDupePerms = {
      ...MOCK_USER,
      roles: [
        { role: { permissions: [{ permission: { name: 'sales.view' } }] } },
        { role: { permissions: [{ permission: { name: 'sales.view' } }] } },
      ],
    };
    const service = await buildService(makePrismaMock(userWithDupePerms), makeRedisMock());

    const result = await service.login(
      { email: 'admin@demo.ensemb.cm', password: 'CorrectPass!1' },
      'org-uuid',
    );

    expect(result.permissions.filter((p: string) => p === 'sales.view')).toHaveLength(1);
  });
});

describe('AuthService.logout', () => {
  it('inscrit le refresh token en blacklist Redis', async () => {
    const redisMock = makeRedisMock();
    const service = await buildService(makePrismaMock(), redisMock);

    await service.logout('my-refresh-token');

    expect(redisMock.set).toHaveBeenCalledWith(
      'blacklist:refresh:my-refresh-token',
      '1',
      expect.any(Number),
    );
  });
});

describe('AuthService.refresh', () => {
  it('revoque ancien token et emet un nouveau pair', async () => {
    const redisMock = makeRedisMock();
    const service = await buildService(makePrismaMock(), redisMock);

    const result = await service.refresh('user-uuid', 'org-uuid', 'admin@demo.ensemb.cm', 'old-token');

    expect(redisMock.set).toHaveBeenCalledWith('blacklist:refresh:old-token', '1', expect.any(Number));
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });
});
