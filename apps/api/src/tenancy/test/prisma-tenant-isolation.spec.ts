import { InternalServerErrorException } from '@nestjs/common';
import { TenantContextService } from '../tenant-context.service';
import { buildTenantExtension } from '../prisma-tenant.extension';

/**
 * Test d'isolation inter-tenant — critère DoD T02.
 * Vérifie que l'extension Prisma injecte organizationId même si le service omet le filtre.
 */
describe('buildTenantExtension — isolation inter-tenant', () => {
  let tenantContext: TenantContextService;

  beforeEach(() => {
    tenantContext = new TenantContextService();
  });

  it('injecte organizationId dans where pour findMany sur un modèle scopé', async () => {
    const orgId = 'org-tenant-a';
    const queryMock = jest.fn().mockResolvedValue([{ id: '1', organizationId: orgId }]);

    const extension = buildTenantExtension(tenantContext);
    const allModels = extension.query.$allModels;

    await tenantContext.run(orgId, () =>
      allModels.$allOperations({
        model: 'User',
        operation: 'findMany',
        args: {},
        query: queryMock,
      }),
    );

    expect(queryMock).toHaveBeenCalledWith({ where: { organizationId: orgId } });
  });

  it('deux tenants simultanés ne voient jamais les données l\'un de l\'autre', async () => {
    const orgA = 'org-a';
    const orgB = 'org-b';

    const capturedArgs: Record<string, unknown>[] = [];
    const queryMock = jest.fn().mockImplementation((args: Record<string, unknown>) => {
      capturedArgs.push(args);
      return Promise.resolve([]);
    });

    const extension = buildTenantExtension(tenantContext);
    const allModels = extension.query.$allModels;

    await Promise.all([
      tenantContext.run(orgA, () =>
        allModels.$allOperations({
          model: 'User',
          operation: 'findMany',
          args: {},
          query: queryMock,
        }),
      ),
      tenantContext.run(orgB, () =>
        allModels.$allOperations({
          model: 'User',
          operation: 'findMany',
          args: {},
          query: queryMock,
        }),
      ),
    ]);

    const orgIds = capturedArgs.map((a) => (a['where'] as { organizationId: string }).organizationId);
    expect(orgIds).toContain(orgA);
    expect(orgIds).toContain(orgB);
    // Chaque appel porte son propre organizationId — pas de contamination croisée
    expect(orgIds[0]).not.toBe(orgIds[1]);
  });

  it('ne modifie pas le where pour les modèles non scopés (Organization)', async () => {
    const queryMock = jest.fn().mockResolvedValue([]);
    const extension = buildTenantExtension(tenantContext);

    await tenantContext.run('org-xyz', () =>
      extension.query.$allModels.$allOperations({
        model: 'Organization',
        operation: 'findMany',
        args: { where: {} },
        query: queryMock,
      }),
    );

    // Le where ne doit pas contenir organizationId pour Organization
    expect(queryMock).toHaveBeenCalledWith({ where: {} });
  });

  it('lève InternalServerErrorException si appelé hors contexte tenant', async () => {
    const queryMock = jest.fn();
    const extension = buildTenantExtension(tenantContext);

    await expect(
      extension.query.$allModels.$allOperations({
        model: 'User',
        operation: 'findMany',
        args: {},
        query: queryMock,
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
