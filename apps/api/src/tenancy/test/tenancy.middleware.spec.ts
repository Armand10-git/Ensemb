import { TenancyMiddleware } from '../tenancy.middleware';
import { TenantContextService } from '../tenant-context.service';
import { TenancyService } from '../tenancy.service';

describe('TenancyMiddleware', () => {
  let middleware: TenancyMiddleware;
  let tenancyService: { resolveOrganizationId: jest.Mock };
  let tenantContext: TenantContextService;

  beforeEach(() => {
    tenancyService = { resolveOrganizationId: jest.fn() };
    tenantContext = new TenantContextService();
    middleware = new TenancyMiddleware(
      tenancyService as unknown as TenancyService,
      tenantContext,
    );
  });

  function makeReq(hostname: string) {
    return { hostname } as never;
  }

  function makeRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  it('retourne 404 quand le sous-domaine est inconnu', async () => {
    tenancyService.resolveOrganizationId.mockResolvedValue(null);

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
    // resolveOrganizationId ne doit pas être appelé — le sous-domaine est rejeté avant
    expect(tenancyService.resolveOrganizationId).not.toHaveBeenCalled();
  });

  it('retourne 404 sur un sous-domaine au format invalide (vecteur injection)', async () => {
    const res = makeRes();
    const next = jest.fn();
    // Tentatived d'injection via header Host malformé
    await middleware.use(makeReq('../evil.monapp.com'), res as never, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(tenancyService.resolveOrganizationId).not.toHaveBeenCalled();
  });

  it('appelle next() et alimente le contexte tenant quand le sous-domaine est valide', async () => {
    const orgId = 'org-uuid-abc';
    tenancyService.resolveOrganizationId.mockResolvedValue(orgId);

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
});
