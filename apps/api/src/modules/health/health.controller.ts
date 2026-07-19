import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './database.health';
import { RedisHealthIndicator } from './redis.health';

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * GET /health — liveness probe.
   * Répond 200 tant que le process tourne. Appelé par l'orchestrateur pour
   * décider si le conteneur doit être redémarré. Aucune dépendance externe.
   */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * GET /ready — readiness probe.
   * Vérifie Postgres et Redis. L'orchestrateur retire le pod du load-balancer
   * tant que ce endpoint renvoie autre chose que 200.
   */
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.isHealthy('postgres'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
