import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';

const CACHE_KEY = 'platform:dashboard:metrics';
const CACHE_TTL_S = 600; // 10 minutes

export interface PlatformMetrics {
  /** MRR courant : somme des priceMonthly des subscriptions ACTIVE (en XAF). */
  mrr: string; // Decimal sérialisé en string pour éviter la perte de précision JSON
  activeOrganizations: number;
  trialingOrganizations: number;
  suspendedOrganizations: number;
  /** Taux de conversion essai→payant sur les 30 derniers jours (0–1). */
  conversionRate: number;
  failedInvoices: number;
  /** Organisations en essai dont trialEndsAt < now + 3 jours. */
  atRiskOrganizations: number;
}

/**
 * Tableau de bord plateforme — métriques agrégées tous tenants confondus.
 *
 * Les métriques sont mises en cache Redis (TTL 10 min) pour ne jamais
 * recalculer sur l'ensemble des données à chaque requête.
 * Clé : platform:dashboard:metrics (globale, pas par tenant).
 */
@Injectable()
export class PlatformAdminDashboardService {
  private readonly logger = new Logger(PlatformAdminDashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Retourne les métriques de la plateforme.
   * Cache Redis hit → données désérialisées.
   * Cache miss → calcul Prisma + mise en cache.
   */
  async getMetrics(): Promise<PlatformMetrics> {
    const cached = await this.redis.get(CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as PlatformMetrics;
      } catch {
        this.logger.warn('Données de cache dashboard invalides — recalcul');
      }
    }

    const metrics = await this.computeMetrics();
    await this.redis.set(CACHE_KEY, JSON.stringify(metrics), CACHE_TTL_S);
    return metrics;
  }

  private async computeMetrics(): Promise<PlatformMetrics> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const atRiskThreshold = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    const [
      mrrRows,
      activeCount,
      trialingCount,
      suspendedCount,
      failedInvoices,
      recentActive,
      recentExpired,
      atRiskCount,
    ] = await Promise.all([
      // MRR : SUM SQL sur les plans des abonnements ACTIVE — évite de charger toutes les lignes en mémoire
      this.prisma.$queryRaw<Array<{ mrr: string }>>`
        SELECT COALESCE(SUM(p.price_monthly), 0)::text AS mrr
        FROM subscriptions s
        JOIN plans p ON s.plan_id = p.id
        WHERE s.status = 'ACTIVE'
      `,
      this.prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      this.prisma.subscription.count({ where: { status: 'TRIALING' } }),
      this.prisma.organization.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.invoice.count({ where: { status: 'FAILED' } }),
      // Conversion : ACTIVE créés sur les 30 derniers jours
      this.prisma.subscription.count({
        where: { status: 'ACTIVE', createdAt: { gte: thirtyDaysAgo } },
      }),
      // Expirés sur les 30 derniers jours : CANCELED mis à jour sur la période
      this.prisma.subscription.count({
        where: { status: 'CANCELED', updatedAt: { gte: thirtyDaysAgo } },
      }),
      // Comptes à risque : TRIALING dont trialEndsAt < now + 3j
      this.prisma.organization.count({
        where: {
          status: 'TRIALING',
          trialEndsAt: { lt: atRiskThreshold },
        },
      }),
    ]);

    // COALESCE garantit toujours une ligne avec une valeur non-nulle
    const mrr = new Decimal(mrrRows[0]?.mrr ?? '0');

    const conversionBase = recentActive + recentExpired;
    const conversionRate = conversionBase > 0
      ? Math.round((recentActive / conversionBase) * 10000) / 10000
      : 0;

    return {
      mrr: mrr.toString(),
      activeOrganizations: activeCount,
      trialingOrganizations: trialingCount,
      suspendedOrganizations: suspendedCount,
      conversionRate,
      failedInvoices,
      atRiskOrganizations: atRiskCount,
    };
  }
}
