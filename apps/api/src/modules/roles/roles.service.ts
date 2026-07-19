import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import type { CreateRoleDto } from './dto/create-role.dto';
import type { UpdateRoleDto } from './dto/update-role.dto';

export interface PaginationQuery {
  page: number;
  limit: number;
}

/**
 * Service de gestion des rôles par organisation.
 * Toutes les opérations sont scopées par organizationId pour garantir l'isolation multi-tenant.
 */
@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crée un nouveau rôle dans l'organisation.
   * Le nom est unique par organisation (contrainte DB + vérification applicative).
   */
  async create(organizationId: string, dto: CreateRoleDto) {
    const existing = await this.prisma.role.findUnique({
      where: { organizationId_name: { organizationId, name: dto.name } },
    });
    if (existing) {
      throw new ConflictException(`Un rôle avec le nom « ${dto.name} » existe déjà.`);
    }

    return this.prisma.role.create({
      data: {
        organizationId,
        name: dto.name,
        label: dto.label,
        description: dto.description,
      },
      select: {
        id: true,
        name: true,
        label: true,
        description: true,
        status: true,
      },
    });
  }

  /**
   * Liste les rôles actifs de l'organisation avec pagination serveur.
   */
  async findAll(organizationId: string, { page, limit }: PaginationQuery) {
    const skip = (page - 1) * limit;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({
        where: { organizationId, status: true },
        skip,
        take: limit,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          label: true,
          description: true,
          status: true,
          _count: { select: { permissions: true, users: true } },
        },
      }),
      this.prisma.role.count({ where: { organizationId, status: true } }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Retourne un rôle avec ses permissions.
   * Vérifie l'appartenance à l'organisation (protection IDOR).
   */
  async findOne(organizationId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId },
      select: {
        id: true,
        name: true,
        label: true,
        description: true,
        status: true,
        permissions: {
          select: { permission: { select: { id: true, name: true, label: true } } },
        },
      },
    });

    if (!role) throw new NotFoundException('Rôle introuvable.');
    return role;
  }

  /**
   * Met à jour le label, la description ou le statut d'un rôle.
   * Le nom (clé technique) n'est pas modifiable après création.
   */
  async update(organizationId: string, roleId: string, dto: UpdateRoleDto) {
    await this.assertExists(organizationId, roleId);

    return this.prisma.role.update({
      where: { id: roleId },
      data: {
        label: dto.label,
        description: dto.description,
        status: dto.status,
      },
      select: {
        id: true,
        name: true,
        label: true,
        description: true,
        status: true,
      },
    });
  }

  /**
   * Désactive un rôle (soft delete via status = false).
   * Les documents financiers ne sont jamais supprimés physiquement.
   */
  async remove(organizationId: string, roleId: string) {
    await this.assertExists(organizationId, roleId);
    await this.prisma.role.update({
      where: { id: roleId },
      data: { status: false },
    });
  }

  /**
   * Ajoute des permissions à un rôle.
   * Vérifie que les permissions existent et que le rôle appartient à l'organisation.
   * Utilise createMany avec skipDuplicates pour l'idempotence.
   */
  async addPermissions(organizationId: string, roleId: string, permissionIds: string[]) {
    await this.assertExists(organizationId, roleId);
    await this.assertPermissionsExist(permissionIds);

    await this.prisma.permissionOnRole.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true,
    });

    return this.findOne(organizationId, roleId);
  }

  /**
   * Retire des permissions d'un rôle.
   */
  async removePermissions(organizationId: string, roleId: string, permissionIds: string[]) {
    await this.assertExists(organizationId, roleId);

    await this.prisma.permissionOnRole.deleteMany({
      where: { roleId, permissionId: { in: permissionIds } },
    });

    return this.findOne(organizationId, roleId);
  }

  /**
   * Assigne un rôle à un utilisateur dans la même organisation.
   * Vérifie l'appartenance de l'utilisateur avant d'assigner (protection IDOR).
   */
  async assignRole(organizationId: string, roleId: string, userId: string) {
    await this.assertExists(organizationId, roleId);
    await this.assertUserInOrg(organizationId, userId);

    await this.prisma.roleOnUser.upsert({
      where: { userId_roleId: { userId, roleId } },
      create: { userId, roleId },
      update: {},
    });
  }

  /**
   * Révoque un rôle d'un utilisateur.
   */
  async revokeRole(organizationId: string, roleId: string, userId: string) {
    await this.assertExists(organizationId, roleId);
    await this.assertUserInOrg(organizationId, userId);

    await this.prisma.roleOnUser.deleteMany({ where: { userId, roleId } });
  }

  // ─── Helpers privés ────────────────────────────────────────────────────────

  private async assertExists(organizationId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId },
      select: { id: true },
    });
    if (!role) throw new NotFoundException('Rôle introuvable.');
  }

  private async assertPermissionsExist(permissionIds: string[]) {
    const found = await this.prisma.permission.findMany({
      where: { id: { in: permissionIds } },
      select: { id: true },
    });
    if (found.length !== permissionIds.length) {
      throw new NotFoundException('Une ou plusieurs permissions sont introuvables.');
    }
  }

  private async assertUserInOrg(organizationId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable dans cette organisation.');
  }
}
