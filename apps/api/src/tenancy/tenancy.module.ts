import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenancyMiddleware } from './tenancy.middleware';
import { PublicOrganizationsController } from './public-organizations.controller';

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
  providers: [TenantContextService, TenancyMiddleware],
  exports: [TenantContextService],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenancyMiddleware)
      .exclude(...EXEMPT_ROUTES)
      .forRoutes('*');
  }
}
