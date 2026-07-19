import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from '../guards/permission.guard';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';

const makePrismaMock = (permissionNames: string[]) => ({
  permissionOnRole: {
    findMany: jest.fn().mockResolvedValue(
      permissionNames.map((name) => ({ permission: { name } })),
    ),
  },
});

const makeContext = (user: { id: string; organizationId: string }): ExecutionContext =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  }) as unknown as ExecutionContext;

describe('PermissionGuard', () => {
  const USER = { id: 'user-uuid', organizationId: 'org-uuid' };

  it('autorise si aucune permission requise', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([]) } as unknown as Reflector;
    const guard = new PermissionGuard(reflector, makePrismaMock([]) as never);

    await expect(guard.canActivate(makeContext(USER))).resolves.toBe(true);
  });

  it("autorise si l'utilisateur possede la permission requise", async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['sales.view']),
    } as unknown as Reflector;
    const guard = new PermissionGuard(
      reflector,
      makePrismaMock(['sales.view', 'pos.access']) as never,
    );

    await expect(guard.canActivate(makeContext(USER))).resolves.toBe(true);
  });

  it('lance ForbiddenException si la permission est absente', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['sales.delete']),
    } as unknown as Reflector;
    const guard = new PermissionGuard(reflector, makePrismaMock(['sales.view']) as never);

    await expect(guard.canActivate(makeContext(USER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('le message erreur est neutre (ne revele pas la permission)', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['secrets.admin']),
    } as unknown as Reflector;
    const guard = new PermissionGuard(reflector, makePrismaMock([]) as never);

    try {
      await guard.canActivate(makeContext(USER));
      fail('Expected ForbiddenException');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException);
      const err = e as ForbiddenException;
      expect(err.message).toBe('Accès refusé.');
      expect(err.message).not.toContain('secrets.admin');
    }
  });

  it('scope par organizationId : appelle Prisma avec le bon organizationId', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['sales.view']),
    } as unknown as Reflector;
    const prismaMock = makePrismaMock(['sales.view']);
    const guard = new PermissionGuard(reflector, prismaMock as never);

    await guard.canActivate(makeContext(USER));

    expect(prismaMock.permissionOnRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: expect.objectContaining({ organizationId: 'org-uuid' }),
        }),
      }),
    );
  });

  it('PERMISSIONS_KEY vaut "permissions"', () => {
    expect(PERMISSIONS_KEY).toBe('permissions');
  });
});
