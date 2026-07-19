import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Déclare la ou les permissions requises pour accéder à un endpoint.
 * Utilisé conjointement avec PermissionGuard.
 *
 * @example @RequirePermission('sales.view')
 * @example @RequirePermission('roles.create', 'roles.edit')
 */
export const RequirePermission = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);
