import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PlatformAdminOrganizationsService } from '../platform-admin-organizations.service';
import { PrismaService } from '../../../common/prisma.service';
import { RedisService } from '../../../common/redis.service';

const mockPrisma = {
  organization: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
};

const mockRedis = {
  set: jest.fn(),
  del: jest.fn(),
};

const ORG = {
  id: 'org-uuid',
  name: 'Test Org',
  subdomain: 'test',
  status: 'TRIALING',
  createdAt: new Date(),
  subscription: { status: 'TRIALING', plan: { name: 'starter' } },
};

describe('PlatformAdminOrganizationsService', () => {
  let service: PlatformAdminOrganizationsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    const module = await Test.createTestingModule({
      providers: [
        PlatformAdminOrganizationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get(PlatformAdminOrganizationsService);
  });

  describe('listOrganizations()', () => {
    it('retourne une liste paginée sans totpSecret ni données sensibles', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([ORG]);
      mockPrisma.organization.count.mockResolvedValue(1);

      const result = await service.listOrganizations(1, 20);

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      const org = result.data[0];
      expect(org).not.toHaveProperty('password');
      expect(org).not.toHaveProperty('totpSecret');
    });
  });

  describe('suspendOrganization()', () => {
    it('update + auditLog dans $transaction et pose la clé Redis', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-uuid', status: 'ACTIVE' });
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      await service.suspendOrganization('org-uuid', 'admin-uuid');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'SUSPENDED' } }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'organization.suspend', actorType: 'PLATFORM_ADMIN' }) }),
      );
      expect(mockRedis.set).toHaveBeenCalledWith('platform:org-suspended:org-uuid', '1', expect.any(Number));
    });

    it('retourne sans action si organisation déjà suspendue (idempotent)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-uuid', status: 'SUSPENDED' });
      await service.suspendOrganization('org-uuid', 'admin-uuid');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si organisation introuvable', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);
      await expect(service.suspendOrganization('unknown', 'admin')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reactivateOrganization()', () => {
    it('update + auditLog dans $transaction et supprime la clé Redis', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-uuid', status: 'SUSPENDED' });
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      await service.reactivateOrganization('org-uuid', 'admin-uuid');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'ACTIVE' } }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'organization.reactivate', actorType: 'PLATFORM_ADMIN' }) }),
      );
      expect(mockRedis.del).toHaveBeenCalledWith('platform:org-suspended:org-uuid');
    });

    it('retourne sans action si organisation déjà active (idempotent)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-uuid', status: 'ACTIVE' });
      await service.reactivateOrganization('org-uuid', 'admin-uuid');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });
});
