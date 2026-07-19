import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BillingService } from './billing.service';
import { QUOTA_RESOURCE_KEY, type QuotaResource } from './check-quota.decorator';
import { PrismaService } from '../../common/prisma.service';

/**
 * Guard de quota : vérifie que l'organisation n'a pas atteint la limite du plan
 * avant d'autoriser une création de ressource.
 *
 * Doit être appliqué après JwtAuthGuard (qui positionne request.user).
 * Usage : @UseGuards(JwtAuthGuard, QuotaGuard) + @CheckQuota('users')
 *
 * Renvoie 403 explicite en français si le quota est atteint — jamais 500.
 */
@Injectable()
export class QuotaGuard implements CanActivate {
  private readonly logger = new Logger(QuotaGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly billingService: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const resource = this.reflector.getAllAndOverride<QuotaResource | undefined>(QUOTA_RESOURCE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Pas de métadonnée @CheckQuota — on laisse passer
    if (!resource) return true;

    const request = context.switchToHttp().getRequest<Request & { user: AuthenticatedUser }>();
    const { organizationId } = request.user;

    let subscription: Awaited<ReturnType<BillingService['getSubscription']>>;
    try {
      subscription = await this.billingService.getSubscription(organizationId);
    } catch (err) {
      this.logger.error(`QuotaGuard : impossible de charger la subscription pour ${organizationId}`, err);
      throw new InternalServerErrorException('Erreur interne lors de la vérification du quota.');
    }

    const { plan } = subscription;
    const limit = this.getLimit(resource, plan);

    // Limite null = illimité — on laisse passer sans compter
    if (limit === null) return true;

    const count = await this.countResource(resource, organizationId);

    if (count >= limit) {
      throw new ForbiddenException(
        `Vous avez atteint la limite de ${limit} ${this.resourceLabel(resource, limit)} de votre plan ${plan.label}.`,
      );
    }

    return true;
  }

  private getLimit(resource: QuotaResource, plan: { maxUsers: number | null; maxWarehouses: number | null; maxProducts: number | null }): number | null {
    switch (resource) {
      case 'users': return plan.maxUsers;
      case 'warehouses': return plan.maxWarehouses;
      case 'products': return plan.maxProducts;
    }
  }

  private async countResource(resource: QuotaResource, organizationId: string): Promise<number> {
    switch (resource) {
      case 'users':
        return this.prisma.user.count({ where: { organizationId, deletedAt: null } });
      case 'warehouses':
        // Warehouse n'existe pas encore — prévu au Bloc C ; on retourne 0 par sécurité
        return 0;
      case 'products':
        // Product n'existe pas encore — prévu au Bloc C ; on retourne 0 par sécurité
        return 0;
    }
  }

  private resourceLabel(resource: QuotaResource, limit: number): string {
    const labels: Record<QuotaResource, [string, string]> = {
      users: ['utilisateur', 'utilisateurs'],
      warehouses: ['entrepôt', 'entrepôts'],
      products: ['produit', 'produits'],
    };
    const [singular, plural] = labels[resource];
    return limit <= 1 ? singular : plural;
  }
}
