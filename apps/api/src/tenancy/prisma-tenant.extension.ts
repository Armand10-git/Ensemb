import { TenantContextService } from './tenant-context.service';

/**
 * Modèles scopés par organizationId — tout findMany/findFirst/findUnique
 * sur ces modèles reçoit automatiquement le filtre organizationId du contexte courant.
 *
 * Modèles exempts (globaux ou hors-tenant) :
 *   Organization, PlatformAdmin, Permission, RoleOnUser, PermissionOnRole
 */
const SCOPED_MODELS = new Set(['user', 'role', 'auditLog'] as const);

type ScopedModel = (typeof SCOPED_MODELS) extends Set<infer T> ? T : never;

function isScopedModel(model: string | undefined): model is ScopedModel {
  return model !== undefined && SCOPED_MODELS.has(model.charAt(0).toLowerCase() + model.slice(1) as ScopedModel);
}

const SCOPED_OPERATIONS = new Set(['findMany', 'findFirst', 'findUnique', 'count', 'findFirstOrThrow', 'findUniqueOrThrow']);

/**
 * Construit un $extends Prisma qui injecte automatiquement `organizationId`
 * dans le `where` de chaque requête de lecture sur les modèles scopés.
 *
 * Défense en profondeur : même si un service omet le filtre, la requête reste isolée.
 */
export function buildTenantExtension(tenantContext: TenantContextService) {
  return {
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model: string | undefined;
          operation: string;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: Record<string, any>;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          query: (args: Record<string, any>) => Promise<any>;
        }) {
          if (isScopedModel(model) && SCOPED_OPERATIONS.has(operation)) {
            const organizationId = tenantContext.getOrganizationId();
            args = {
              ...args,
              where: {
                ...((args['where'] as Record<string, unknown>) ?? {}),
                organizationId,
              },
            };
          }
          return query(args);
        },
      },
    },
  };
}
