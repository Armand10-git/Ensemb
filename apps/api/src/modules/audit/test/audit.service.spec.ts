import { Logger } from '@nestjs/common';
import { AuditService } from '../audit.service';
import type { PrismaService } from '../../../common/prisma.service';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makePrisma(overrides?: Partial<{
  auditLogCreate: jest.Mock;
  auditLogCount: jest.Mock;
  auditLogFindMany: jest.Mock;
  rolesFindUnique: jest.Mock;
}>): jest.Mocked<Pick<PrismaService, 'auditLog'>> & { role: { findUnique: jest.Mock } } {
  return {
    auditLog: {
      create: overrides?.auditLogCreate ?? jest.fn().mockResolvedValue({}),
      count: overrides?.auditLogCount ?? jest.fn().mockResolvedValue(0),
      findMany: overrides?.auditLogFindMany ?? jest.fn().mockResolvedValue([]),
    } as unknown as PrismaService['auditLog'],
    role: {
      findUnique: overrides?.rolesFindUnique ?? jest.fn().mockResolvedValue(null),
    },
  };
}

describe('AuditService', () => {
  describe('create', () => {
    it('persiste un AuditLog avec les champs corrects', async () => {
      const prismaCreate = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ auditLogCreate: prismaCreate });
      const service = new AuditService(prisma as unknown as PrismaService);

      await service.create({
        organizationId: VALID_UUID,
        actorType: 'USER',
        actorId: VALID_UUID,
        action: 'roles.update',
        entity: 'Role',
        entityId: VALID_UUID,
        before: { name: 'Old' },
        after: { name: 'New' },
      });

      expect(prismaCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'roles.update',
          entity: 'Role',
          actorType: 'USER',
        }),
      });
    });

    it('ne leve pas d erreur si la persistence echoue', async () => {
      const prismaCreate = jest.fn().mockRejectedValue(new Error('DB down'));
      const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const prisma = makePrisma({ auditLogCreate: prismaCreate });
      const service = new AuditService(prisma as unknown as PrismaService);

      await expect(service.create({
        organizationId: null,
        actorType: 'SYSTEM',
        action: 'roles.update',
        entity: 'Role',
      })).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe('fetchEntitySnapshot', () => {
    it('retourne l entite si le modele Prisma existe', async () => {
      const entity = { id: VALID_UUID, name: 'Admin' };
      const findUnique = jest.fn().mockResolvedValue(entity);
      const prisma = makePrisma({ rolesFindUnique: findUnique });
      const service = new AuditService(prisma as unknown as PrismaService);

      const result = await service.fetchEntitySnapshot('Role', VALID_UUID);
      expect(result).toEqual(entity);
      expect(findUnique).toHaveBeenCalledWith({ where: { id: VALID_UUID } });
    });

    it('retourne null si le modele Prisma n existe pas', async () => {
      const prisma = makePrisma();
      const service = new AuditService(prisma as unknown as PrismaService);

      const result = await service.fetchEntitySnapshot('NonExistentModel', VALID_UUID);
      expect(result).toBeNull();
    });

    it('retourne null si findUnique echoue', async () => {
      const findUnique = jest.fn().mockRejectedValue(new Error('DB error'));
      const prisma = makePrisma({ rolesFindUnique: findUnique });
      const service = new AuditService(prisma as unknown as PrismaService);

      const result = await service.fetchEntitySnapshot('Role', VALID_UUID);
      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('retourne les entrees paginées avec meta correcte', async () => {
      const rows = [{ id: VALID_UUID, action: 'roles.update' }];
      const prisma = makePrisma({
        auditLogFindMany: jest.fn().mockResolvedValue(rows),
        auditLogCount: jest.fn().mockResolvedValue(42),
      });
      const service = new AuditService(prisma as unknown as PrismaService);

      const result = await service.findAll(VALID_UUID, { page: 2, limit: 10 });
      expect(result.data).toEqual(rows);
      expect(result.meta).toEqual({ total: 42, page: 2, limit: 10, totalPages: 5 });
    });
  });
});
