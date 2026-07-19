import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PlatformAdminOrganizationsService } from '../platform-admin-organizations.service';
import { PrismaService } from '../../../common/prisma.service';
import { RedisService } from '../../../common/redis.service';
import { AuditService } from '../../audit/audit.service';

const mockPrisma = {
  organization: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const mockRedis = {
  set: jest.fn(),
  del: jest.fn(),
};

const mockAudit = { create: jest.fn() };

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
    const module = await Test.createTestingModule({
      providers: [
        PlatformAdminOrganizationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AuditService, useValue: mockAudit },
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
      // Aucune propriété sensible
      const org = result.data[0];
      expect(org).not.toHaveProperty('password');
      expect(org).not.toHaveProperty('totpSecret');
    });
  });

  describe('suspendOrganization()', () => {
    it('met status=SUSPENDED, pose la clé Redis et crée un AuditLog', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-uuid', status: 'ACTIVE', name: 'Test' });
      mockPrisma.organization.update.mockResolvedValue({});

      await service.suspendOrganization('org-uuid', 'admin-uuid');

      expect(mockPrisma.organization.update).toHaveBeenCalledWith({
        where: { id: 'org-uuid' },
        data: { status: 'SUSPENDED' },
      });
      expect(mockRedis.set).toHaveBeenCalledWith('platform:org-suspended:org-uuid', '1', expect.any(Number));
      expect(mockAudit.create).toHaveBeenCalledWith(expect.objectContaining({
        actorType: 'PLATFORM_ADMIN',
        actorId: 'admin-uuid',
        action: 'organization.suspend',
      }));
    });

    it('lève NotFoundException si organisation introuvable', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);
      await expect(service.suspendOrganization('unknown', 'admin')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reactivateOrganization()', () => {
    it('met status=ACTIVE, supprime la clé Redis et crée un AuditLog', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-uuid', status: 'SUSPENDED' });
      mockPrisma.organization.update.mockResolvedValue({});

      await service.reactivateOrganization('org-uuid', 'admin-uuid');

      expect(mockPrisma.organization.update).toHaveBeenCalledWith({
        where: { id: 'org-uuid' },
        data: { status: 'ACTIVE' },
      });
      expect(mockRedis.del).toHaveBeenCalledWith('platform:org-suspended:org-uuid');
      expect(mockAudit.create).toHaveBeenCalledWith(expect.objectContaining({
        actorType: 'PLATFORM_ADMIN',
        actorId: 'admin-uuid',
        action: 'organization.reactivate',
      }));
    });
  });
});
