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

let HASHED_PASSWORD: string;

const MOCK_USER = () => ({
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
});

beforeAll(async () => {
  HASHED_PASSWORD = await bcrypt.hash('CorrectPass!1', 10);
});

const makePrismaMock = (userOverride?: Record<string, unknown> | null) => ({
  user: {
    findFirst: jest.fn().mockResolvedValue(
      userOverride === null ? null : { ...MOCK_USER(), ...userOverride },
    ),
  },
});

const makeRedisMock = () => ({
  set: jest.fn().mockResolvedValue(undefined),
  setNx: jest.fn().mockResolvedValue(true),
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
      ...MOCK_USER(),
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

  it('email inexistant et mauvais mdp retournent le meme message (anti-enumeration)', async () => {
    const serviceNoUser = await buildService(makePrismaMock(null), makeRedisMock());
    const serviceWrongPw = await buildService(makePrismaMock(), makeRedisMock());

    const errNoUser = await serviceNoUser.login({ email: 'x@x.cm', password: 'any' }, 'org').catch((e: UnauthorizedException) => e);
    const errWrongPw = await serviceWrongPw.login({ email: 'admin@demo.ensemb.cm', password: 'bad' }, 'org-uuid').catch((e: UnauthorizedException) => e);

    expect((errNoUser as UnauthorizedException).message).toBe((errWrongPw as UnauthorizedException).message);
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
  it('revoque ancien token via setNx et emet un nouveau pair', async () => {
    const redisMock = makeRedisMock();
    const service = await buildService(makePrismaMock(), redisMock);

    const result = await service.refresh('user-uuid', 'org-uuid', 'admin@demo.ensemb.cm', 'old-token');

    expect(redisMock.setNx).toHaveBeenCalledWith('blacklist:refresh:old-token', '1', expect.any(Number));
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });
});
