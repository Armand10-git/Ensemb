import { TenancyService } from '../tenancy.service';
import { SUBDOMAIN_CACHE_KEY_PREFIX, SUBDOMAIN_CACHE_TTL_SECONDS } from '../tenancy.constants';

describe('TenancyService', () => {
  let service: TenancyService;
  let prisma: { organization: { findUnique: jest.Mock } };
  let redis: { get: jest.Mock; set: jest.Mock };

  beforeEach(() => {
    prisma = { organization: { findUnique: jest.fn() } };
    redis = { get: jest.fn(), set: jest.fn() };
    service = new TenancyService(prisma as never, redis as never);
  });

  it('retourne null si le sous-domaine est absent du cache et de la base', async () => {
    redis.get.mockResolvedValue(null);
    prisma.organization.findUnique.mockResolvedValue(null);

    const result = await service.resolveOrganizationId('inconnu');
    expect(result).toBeNull();
  });

  it('retourne l\'organizationId depuis le cache Redis sans appeler Prisma', async () => {
    const orgId = 'org-cached';
    redis.get.mockResolvedValue(orgId);

    const result = await service.resolveOrganizationId('tenant');
    expect(result).toBe(orgId);
    expect(prisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('met en cache le résultat Prisma avec le bon TTL après un cache miss', async () => {
    const orgId = 'org-from-db';
    redis.get.mockResolvedValue(null);
    prisma.organization.findUnique.mockResolvedValue({ id: orgId });
    redis.set.mockResolvedValue(undefined);

    const result = await service.resolveOrganizationId('nouveau-tenant');
    expect(result).toBe(orgId);
    expect(redis.set).toHaveBeenCalledWith(
      `${SUBDOMAIN_CACHE_KEY_PREFIX}nouveau-tenant`,
      orgId,
      SUBDOMAIN_CACHE_TTL_SECONDS,
    );
  });
});
