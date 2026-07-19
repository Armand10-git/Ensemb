import { HealthCheckService, HealthCheckError } from '@nestjs/terminus';
import { HealthController } from '../health.controller';
import { DatabaseHealthIndicator } from '../database.health';
import { RedisHealthIndicator } from '../redis.health';

const makeHealthService = (result: unknown) =>
  ({ check: jest.fn().mockResolvedValue(result) }) as unknown as HealthCheckService;

const makeDb = () =>
  ({ isHealthy: jest.fn().mockResolvedValue({ postgres: { status: 'up' } }) }) as unknown as DatabaseHealthIndicator;

const makeRedis = () =>
  ({ isHealthy: jest.fn().mockResolvedValue({ redis: { status: 'up' } }) }) as unknown as RedisHealthIndicator;

describe('HealthController', () => {
  describe('liveness (GET /health)', () => {
    it('retourne { status: "ok" } sans appeler les indicateurs', () => {
      const healthService = makeHealthService({});
      const ctrl = new HealthController(healthService, makeDb(), makeRedis());

      const result = ctrl.liveness();

      expect(result).toEqual({ status: 'ok' });
      expect(healthService.check).not.toHaveBeenCalled();
    });
  });

  describe('readiness (GET /ready)', () => {
    it('retourne le rapport terminus quand Postgres et Redis sont up', async () => {
      const report = { status: 'ok', info: { postgres: { status: 'up' }, redis: { status: 'up' } } };
      const healthService = makeHealthService(report);
      const ctrl = new HealthController(healthService, makeDb(), makeRedis());

      const result = await ctrl.readiness();

      expect(healthService.check).toHaveBeenCalledTimes(1);
      expect(result).toEqual(report);
    });

    it('propage HealthCheckError quand Redis est injoignable', async () => {
      const healthService = {
        check: jest.fn().mockRejectedValue(
          new HealthCheckError('Redis unreachable', { redis: { status: 'down' } }),
        ),
      } as unknown as HealthCheckService;
      const ctrl = new HealthController(healthService, makeDb(), makeRedis());

      await expect(ctrl.readiness()).rejects.toBeInstanceOf(HealthCheckError);
    });
  });
});
