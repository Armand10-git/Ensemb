import { SetMetadata } from '@nestjs/common';

export const AUDITABLE_KEY = 'auditable';

export interface AuditableMetadata {
  /** Identifiant de l'action, ex. "roles.update", "permissions.assign". */
  action: string;
  /** Nom du modèle Prisma concerné, ex. "Role". */
  entity: string;
}

/**
 * Marque un endpoint comme devant être journalisé dans AuditLog.
 * L'AuditInterceptor lit cette métadonnée pour déclencher la persistence.
 */
export const Auditable = (metadata: AuditableMetadata) =>
  SetMetadata(AUDITABLE_KEY, metadata);
