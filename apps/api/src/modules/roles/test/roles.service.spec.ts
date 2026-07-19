import { ConflictException, NotFoundException } from '@nestjs/common';
import { RolesService } from '../roles.service';

const ORG_ID = 'org-uuid';
const ROLE_ID = 'role-uuid';
const USER_ID = 'user-uuid';
const PERM_ID = 'perm-uuid';

const MOCK_ROLE = {
  id: ROLE_ID,
  name: 'caissier',
  label: 'Caissier',
  description: null,
  status: true,
  organizationId: ORG_ID,
};

const MOCK_ROLE_DETAIL = {
  ...MOCK_ROLE,
  permissions: [{ permission: { id: PERM_ID, name: 'pos.access', label: 'Acces caisse' } }],
};

const makePrisma = (overrides: Record<string, unknown> = {}) => ({
  role: {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(MOCK_ROLE),
    findMany: jest.fn().mockResolvedValue([MOCK_ROLE]),
    count: jest.fn().mockResolvedValue(1),
    create: jest.fn().mockResolvedValue(MOCK_ROLE),
    update: jest.fn().mockResolvedValue(MOCK_ROLE),
    ...((overrides['role'] as Record<string, unknown>) ?? {}),
  },
  permissionOnRole: {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    ...((overrides['permissionOnRole'] as Record<string, unknown>) ?? {}),
  },
  permission: {
    findMany: jest.fn().mockResolvedValue([{ id: PERM_ID }]),
    ...((overrides['permission'] as Record<string, unknown>) ?? {}),
  },
  roleOnUser: {
    upsert: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    ...((overrides['roleOnUser'] as Record<string, unknown>) ?? {}),
  },
  user: {
    findFirst: jest.fn().mockResolvedValue({ id: USER_ID }),
    ...((overrides['user'] as Record<string, unknown>) ?? {}),
  },
  $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  ...overrides,
});

describe('RolesService', () => {
  describe('create', () => {
    it('cree un role si le nom est unique', async () => {
      const prisma = makePrisma();
      const service = new RolesService(prisma as never);

      const result = await service.create(ORG_ID, { name: 'caissier', label: 'Caissier' });

      expect(prisma.role.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ organizationId: ORG_ID, name: 'caissier' }),
        }),
      );
      expect(result).toMatchObject({ name: 'caissier' });
    });

    it('lance ConflictException si le nom existe deja', async () => {
      const prisma = makePrisma({
        role: { findUnique: jest.fn().mockResolvedValue(MOCK_ROLE) },
      });
      const service = new RolesService(prisma as never);

      await expect(service.create(ORG_ID, { name: 'caissier' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('findAll', () => {
    it('scope par organizationId', async () => {
      const prisma = makePrisma();
      const service = new RolesService(prisma as never);

      await service.findAll(ORG_ID, { page: 1, limit: 20 });

      expect(prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: ORG_ID }),
        }),
      );
    });

    it('calcule le bon offset (page 2, limit 5 -> skip 5)', async () => {
      const prisma = makePrisma();
      const service = new RolesService(prisma as never);

      await service.findAll(ORG_ID, { page: 2, limit: 5 });

      expect(prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
    });
  });

  describe('findOne', () => {
    it('retourne le role avec ses permissions', async () => {
      const prisma = makePrisma({
        role: { findFirst: jest.fn().mockResolvedValue(MOCK_ROLE_DETAIL) },
      });
      const service = new RolesService(prisma as never);

      const result = await service.findOne(ORG_ID, ROLE_ID);

      expect(prisma.role.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ROLE_ID, organizationId: ORG_ID } }),
      );
      expect(result).toMatchObject({ id: ROLE_ID });
    });

    it("lance NotFoundException si le role n'appartient pas a l'organisation", async () => {
      const prisma = makePrisma({
        role: { findFirst: jest.fn().mockResolvedValue(null) },
      });
      const service = new RolesService(prisma as never);

      await expect(service.findOne('autre-org', ROLE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove (soft delete)', () => {
    it('desactive le role (status = false)', async () => {
      const prisma = makePrisma();
      const service = new RolesService(prisma as never);

      await service.remove(ORG_ID, ROLE_ID);

      expect(prisma.role.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: false } }),
      );
    });

    it("lance NotFoundException si le role n'existe pas dans l'organisation", async () => {
      const prisma = makePrisma({
        role: { findFirst: jest.fn().mockResolvedValue(null) },
      });
      const service = new RolesService(prisma as never);

      await expect(service.remove(ORG_ID, ROLE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('addPermissions', () => {
    it('ajoute les permissions avec skipDuplicates', async () => {
      const findFirstMock = jest
        .fn()
        .mockResolvedValueOnce(MOCK_ROLE)        // assertExists
        .mockResolvedValueOnce(MOCK_ROLE_DETAIL); // findOne interne
      const prisma = makePrisma({ role: { findFirst: findFirstMock } });
      const service = new RolesService(prisma as never);

      await service.addPermissions(ORG_ID, ROLE_ID, [PERM_ID]);

      expect(prisma.permissionOnRole.createMany).toHaveBeenCalledWith({
        data: [{ roleId: ROLE_ID, permissionId: PERM_ID }],
        skipDuplicates: true,
      });
    });

    it('lance NotFoundException si une permission est introuvable', async () => {
      const prisma = makePrisma({
        permission: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const service = new RolesService(prisma as never);

      await expect(service.addPermissions(ORG_ID, ROLE_ID, [PERM_ID])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('assignRole', () => {
    it("lance NotFoundException si l'utilisateur n'appartient pas a l'organisation", async () => {
      const prisma = makePrisma({
        user: { findFirst: jest.fn().mockResolvedValue(null) },
      });
      const service = new RolesService(prisma as never);

      await expect(service.assignRole(ORG_ID, ROLE_ID, USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
