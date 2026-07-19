import { TenancyMiddleware } from '../tenancy.middleware';
import { TenantContextService } from '../tenant-context.service';

describe('TenancyMiddleware', () => {
  let middleware: TenancyMiddleware;
  let prisma: { organization: { findUnique: jest.Mock } };
  let redis: { get: jest.Mock; set: jest.Mock };
  let tenantContext: TenantContextService;

  beforeEach(() => {
    prisma = { organization: { findUnique: jest.fn() } };
    redis = { get: jest.fn(), set: jest.fn() };
    tenantContext = new TenantContextService();
    middleware = new TenancyMiddleware(
      prisma as never,
      redis as never,
      tenantContext,
    );
  });

  function makeReq(hostname: string) {
    return { hostname } as never;
  }

  function makeRes() {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res;
  }

  it('retourne 404 quand le sous-domaine est inconnu (ni cache ni base)', async () => {
    redis.get.mockResolvedValue(null);
    prisma.organization.findUnique.mockResolvedValue(null);

    const res = makeRes();
    const next = jest.fn();
    await middleware.use(makeReq('inconnu.monapp.com'), res as never, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Organisation introuvable' });
    expect(next).not.toHaveBeenCalled();
  });

  it('retourne 404 sur localhost (pas de sous-domaine)', async () => {
    const res = makeRes();
    const next = jest.fn();
    await middleware.use(makeReq('localhost'), res as never, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('appelle next() et alimente le contexte tenant quand le sous-domaine est valide (cache)', async () => {
    const orgId = 'org-uuid-abc';
    redis.get.mockResolvedValue(orgId);

    const res = makeRes();
    let capturedOrgId: string | undefined;
    const next = jest.fn(() => {
      capturedOrgId = tenantContext.getOrganizationId();
    });

    await middleware.use(makeReq('boutique.monapp.com'), res as never, next);

    expect(next).toHaveBeenCalled();
    expect(capturedOrgId).toBe(orgId);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('met en cache le résultat Prisma après lookup réussi', async () => {
    const orgId = 'org-uuid-def';
    redis.get.mockResolvedValue(null);
    prisma.organization.findUnique.mockResolvedValue({ id: orgId });
    redis.set.mockResolvedValue(undefined);

    const next = jest.fn();
    await middleware.use(makeReq('tenant.monapp.com'), makeRes() as never, next);

    expect(redis.set).toHaveBeenCalledWith('org:bySubdomain:tenant', orgId, 3600);
    expect(next).toHaveBeenCalled();
  });
});
