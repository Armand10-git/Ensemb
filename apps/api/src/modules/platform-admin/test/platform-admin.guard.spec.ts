import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PlatformAdminGuard } from '../platform-admin.guard';
import { PrismaService } from '../../../common/prisma.service';

const PLATFORM_SECRET = 'platform-secret';

const mockJwt = { verifyAsync: jest.fn() };
const mockConfig = { getOrThrow: jest.fn().mockReturnValue(PLATFORM_SECRET) };
const mockPrisma = { platformAdmin: { findUnique: jest.fn() } };

function makeContext(token: string | null): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { authorization: token ? `Bearer ${token}` : undefined },
        platformAdmin: undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('PlatformAdminGuard', () => {
  let guard: PlatformAdminGuard;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { Test } = await import('@nestjs/testing');
    const module = await Test.createTestingModule({
      providers: [
        PlatformAdminGuard,
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    guard = module.get(PlatformAdminGuard);
  });

  it('accepte un token complet valide et injecte platformAdmin dans req', async () => {
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'admin-uuid', email: 'a@b.com' });
    mockPrisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-uuid', email: 'a@b.com', isActive: true });

    const req: { headers: { authorization: string }; platformAdmin?: { id: string } } = {
      headers: { authorization: 'Bearer valid-token' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.platformAdmin?.id).toBe('admin-uuid');
  });

  it('rejette un token temporaire MFA (step présent)', async () => {
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'admin-uuid', email: 'a@b.com', step: 'mfa' });
    await expect(guard.canActivate(makeContext('temp-token'))).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un token signé avec JWT_SECRET (tenant) — verifyAsync lève une erreur', async () => {
    mockJwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    await expect(guard.canActivate(makeContext('tenant-token'))).rejects.toThrow(UnauthorizedException);
  });

  it('rejette si PlatformAdmin.isActive = false', async () => {
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'admin-uuid', email: 'a@b.com' });
    mockPrisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-uuid', email: 'a@b.com', isActive: false });
    await expect(guard.canActivate(makeContext('valid-token'))).rejects.toThrow(UnauthorizedException);
  });

  it('rejette si token manquant', async () => {
    await expect(guard.canActivate(makeContext(null))).rejects.toThrow(UnauthorizedException);
  });
});
