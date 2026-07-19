import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../../common/prisma.service';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import type { AuthenticatedUser } from '../strategies/jwt.strategy';

/**
 * Guard d'autorisation basé sur les permissions.
 * Doit être appliqué après JwtAuthGuard (qui positionne request.user).
 *
 * Vérifie que l'utilisateur authentifié possède au moins une des permissions
 * déclarées via @RequirePermission(). Si aucune permission n'est déclarée,
 * l'accès est autorisé.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user: AuthenticatedUser }>();
    const user = request.user;

    const owned = await this.getUserPermissions(user.id, user.organizationId);
    const hasPermission = required.some((p) => owned.has(p));

    if (!hasPermission) {
      // Message neutre — ne révèle pas quelle permission est absente.
      throw new ForbiddenException('Accès refusé.');
    }

    return true;
  }

  /**
   * Charge l'ensemble des noms de permissions de l'utilisateur dans son organisation.
   * Scopé par organizationId pour éviter toute fuite inter-tenant.
   */
  async getUserPermissions(userId: string, organizationId: string): Promise<Set<string>> {
    const rows = await this.prisma.permissionOnRole.findMany({
      where: {
        role: {
          organizationId,
          users: { some: { userId } },
        },
      },
      select: { permission: { select: { name: true } } },
    });

    return new Set(rows.map((r) => r.permission.name));
  }
}
