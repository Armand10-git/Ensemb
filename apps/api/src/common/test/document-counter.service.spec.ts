import { Test } from '@nestjs/testing';
import { DocumentCounterService } from '../document-counter.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B = 'bbbb0000-0000-0000-0000-000000000002';
const YEAR = 2026;

type TxMock = {
  documentCounter: {
    upsert: jest.Mock;
  };
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('DocumentCounterService', () => {
  let service: DocumentCounterService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [DocumentCounterService],
    }).compile();

    service = module.get(DocumentCounterService);
  });

  function makeTx(upsertResult: { lastCounter: number }): TxMock {
    return {
      documentCounter: {
        upsert: jest.fn().mockResolvedValue(upsertResult),
      },
    };
  }

  it('premier appel (counter inexistant) → lastCounter=1, référence VTE-2026-000001', async () => {
    const tx = makeTx({ lastCounter: 1 });
    const ref = await service.nextReference(tx as never, ORG_A, 'SALE', YEAR);
    expect(ref).toBe('VTE-2026-000001');
    expect(tx.documentCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ lastCounter: 1 }),
        update: { lastCounter: { increment: 1 } },
      }),
    );
  });

  it('deuxième appel → lastCounter=2, référence VTE-2026-000002', async () => {
    const tx = makeTx({ lastCounter: 2 });
    const ref = await service.nextReference(tx as never, ORG_A, 'SALE', YEAR);
    expect(ref).toBe('VTE-2026-000002');
  });

  it('deux types différents dans la même org → compteurs indépendants', async () => {
    const txSale = makeTx({ lastCounter: 1 });
    const txPurchase = makeTx({ lastCounter: 1 });

    const refSale     = await service.nextReference(txSale     as never, ORG_A, 'SALE',     YEAR);
    const refPurchase = await service.nextReference(txPurchase as never, ORG_A, 'PURCHASE', YEAR);

    expect(refSale).toBe('VTE-2026-000001');
    expect(refPurchase).toBe('ACH-2026-000001');

    // Les deux upserts ciblent des clés composites distinctes
    expect(txSale.documentCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId_documentType_year: expect.objectContaining({ documentType: 'SALE' }) }),
      }),
    );
    expect(txPurchase.documentCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId_documentType_year: expect.objectContaining({ documentType: 'PURCHASE' }) }),
      }),
    );
  });

  it('deux orgs différentes → compteurs indépendants', async () => {
    const txA = makeTx({ lastCounter: 1 });
    const txB = makeTx({ lastCounter: 1 });

    const refA = await service.nextReference(txA as never, ORG_A, 'SALE', YEAR);
    const refB = await service.nextReference(txB as never, ORG_B, 'SALE', YEAR);

    expect(refA).toBe('VTE-2026-000001');
    expect(refB).toBe('VTE-2026-000001');

    expect(txA.documentCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId_documentType_year: expect.objectContaining({ organizationId: ORG_A }) }),
      }),
    );
    expect(txB.documentCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId_documentType_year: expect.objectContaining({ organizationId: ORG_B }) }),
      }),
    );
  });

  it('année par défaut = année UTC courante', async () => {
    const tx = makeTx({ lastCounter: 1 });
    const currentYear = new Date().getUTCFullYear();

    await service.nextReference(tx as never, ORG_A, 'SALE');

    expect(tx.documentCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId_documentType_year: expect.objectContaining({ year: currentYear }),
        }),
      }),
    );
  });
});
