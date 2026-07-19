import { Controller, Get, UseGuards } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminDashboardService } from './platform-admin-dashboard.service';

/**
 * Tableau de bord plateforme — métriques agrégées (MRR, conversions, etc.).
 * Préfixe : /api/v1/platform-admin/dashboard
 */
@Controller('platform-admin/dashboard')
@UseGuards(PlatformAdminGuard)
export class PlatformAdminDashboardController {
  constructor(private readonly dashboardService: PlatformAdminDashboardService) {}

  /**
   * Retourne les métriques plateforme (cache Redis 10 min).
   * MRR retourné en string (Decimal sérialisé, jamais Float).
   */
  @Get()
  async getMetrics() {
    return this.dashboardService.getMetrics();
  }
}
