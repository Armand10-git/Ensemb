import { InternalServerErrorException } from '@nestjs/common';
import { TenantContextService } from '../tenant-context.service';

describe('TenantContextService', () => {
  let service: TenantContextService;

  beforeEach(() => {
    service = new TenantContextService();
  });

  it('retourne l\'organizationId quand appelé dans un contexte run()', () => {
    const orgId = 'org-uuid-123';
    service.run(orgId, () => {
      expect(service.getOrganizationId()).toBe(orgId);
    });
  });

  it('lève InternalServerErrorException quand appelé hors contexte', () => {
    expect(() => service.getOrganizationId()).toThrow(InternalServerErrorException);
  });

  it('isole les contextes entre deux run() imbriqués', async () => {
    const orgA = 'org-a';
    const orgB = 'org-b';

    const results: string[] = [];

    await Promise.all([
      new Promise<void>((resolve) => {
        service.run(orgA, () => {
          // Simule un délai asynchrone pour vérifier l'isolation
          setImmediate(() => {
            results.push(service.getOrganizationId());
            resolve();
          });
        });
      }),
      new Promise<void>((resolve) => {
        service.run(orgB, () => {
          setImmediate(() => {
            results.push(service.getOrganizationId());
            resolve();
          });
        });
      }),
    ]);

    expect(results).toContain(orgA);
    expect(results).toContain(orgB);
    // Chaque contexte retourne son propre organizationId
    expect(results).toHaveLength(2);
  });
});
