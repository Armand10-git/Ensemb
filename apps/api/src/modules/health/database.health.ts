import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

/**
 * Vérifie la connectivité PostgreSQL avec une requête SELECT 1.
 * Instancie un pool dédié pour éviter la dépendance à Prisma (non encore configuré en S02).
 */
@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  private readonly pool: Pool;

  constructor(private readonly config: ConfigService) {
    super();
    this.pool = new Pool({ connectionString: this.config.get<string>('DATABASE_URL') });
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.pool.query('SELECT 1');
      return this.getStatus(key, true);
    } catch (error) {
      throw new HealthCheckError('PostgreSQL unreachable', this.getStatus(key, false, { error: String(error) }));
    }
  }
}
