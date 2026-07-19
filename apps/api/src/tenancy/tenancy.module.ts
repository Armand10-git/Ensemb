import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { TenantContextService } from './tenant-context.service';
import { TenancyMiddleware } from './tenancy.middleware';
import { TenancyService } from './tenancy.service';
import { PublicOrganizationsController } from './public-organizations.controller';
import { buildTenantExtension } from './prisma-tenant.extension';

/**
 * Token d'injection pour le client Prisma étendu avec l'auto-scoping tenant.
 * Les modules métier injectent ce token à la place de PrismaService pour bénéficier
 * de la défense en profondeur (WHERE organizationId injecté automatiquement).
 *
 * PrismaService brut reste disponible pour les opérations hors-tenant
 * (AuthModule, HealthModule, PlatformAdminModule…).
 */
export const PRISMA_TENANT_CLIENT = 'PRISMA_TENANT_CLIENT';

/**
 * Routes exemptées du middleware tenant (pas de sous-domaine requis).
 * /health et /ready sont appelés sans préfixe par l'orchestrateur.
 * /api/v1/auth/* sont des endpoints publics d'authentification.
 * /api/v1/public/* est l'endpoint de résolution de tenant pour le mobile.
 */
const EXEMPT_ROUTES = [
  { path: 'health', method: RequestMethod.GET },
  { path: 'ready', method: RequestMethod.GET },
  { path: 'api/v1/auth/(.*)', method: RequestMethod.ALL },
  { path: 'api/v1/public/(.*)', method: RequestMethod.ALL },
];

@Module({
  controllers: [PublicOrganizationsController],
  providers: [
    TenantContextService,
    TenancyService,
    TenancyMiddleware,
    {
      provide: PRISMA_TENANT_CLIENT,
      useFactory: (prisma: PrismaService, tenantContext: TenantContextService) =>
        prisma.$extends(buildTenantExtension(tenantContext)),
      inject: [PrismaService, TenantContextService],
    },
  ],
  exports: [TenantContextService, TenancyService, PRISMA_TENANT_CLIENT],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenancyMiddleware)
      .exclude(...EXEMPT_ROUTES)
      .forRoutes('*');
  }
}
