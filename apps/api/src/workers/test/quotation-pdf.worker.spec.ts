import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { QuotationPdfWorker } from '../quotation-pdf.worker';

const QUOTATION_ID = 'quot0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; documentId?: string; documentType?: string; requestedBy?: string },
  name = 'quotation.generatePdf',
) {
  return { name, data } as never;
}

const FAKE_QUOTATION = {
  id: QUOTATION_ID,
  organizationId: ORG_ID,
  reference: 'DEV-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'PENDING',
  discount: null,
  taxAmount: null,
  shipping: null,
  grandTotal: new Decimal('10000'),
  client: { id: 'client-1', name: 'Client Test' },
  warehouse: { id: 'wh-1', name: 'Entrepôt Central' },
  details: [
    {
      productId: 'prod-1',
      quantity: new Decimal('1'),
      price: new Decimal('10000'),
      total: new Decimal('10000'),
    },
  ],
};

describe('QuotationPdfWorker', () => {
  let quotationService: { findOne: jest.Mock };
  let pdfService: { render: jest.Mock };
  let storageService: { upload: jest.Mock; getSignedUrl: jest.Mock };
  let prisma: { product: { findMany: jest.Mock }; organization: { findUnique: jest.Mock } };
  let worker: QuotationPdfWorker;

  beforeEach(() => {
    quotationService = { findOne: jest.fn() };
    pdfService = { render: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')) };
    storageService = {
      upload: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest.fn().mockResolvedValue('https://signed.example.com/quotation.pdf'),
    };
    prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'prod-1', name: 'Produit test' }]) },
      organization: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Boutique Ensemb', logoUrl: null, primaryColor: null }),
      },
    };
    worker = new QuotationPdfWorker(
      quotationService as never,
      pdfService as never,
      storageService as never,
      prisma as never,
      {} as never,
    );
  });

  it('recharge le devis, rend le PDF, l\'uploade avec la bonne clé et émet pdf:ready', async () => {
    quotationService.findOne.mockResolvedValue(FAKE_QUOTATION);
    const emit = jest.fn();
    const rtWorker = new QuotationPdfWorker(
      quotationService as never,
      pdfService as never,
      storageService as never,
      prisma as never,
      { server: { to: jest.fn().mockReturnValue({ emit }) } } as never,
    );

    await rtWorker.process(
      makeJob({ organizationId: ORG_ID, documentId: QUOTATION_ID, requestedBy: 'user-1' }),
    );

    expect(quotationService.findOne).toHaveBeenCalledWith(QUOTATION_ID, ORG_ID);
    expect(pdfService.render).toHaveBeenCalledTimes(1);
    const html = pdfService.render.mock.calls[0][0] as string;
    expect(html).toContain('Produit test');
    expect(html).toContain('Client Test');

    expect(storageService.upload).toHaveBeenCalledWith(
      `${ORG_ID}/pdf/quotation/${QUOTATION_ID}.pdf`,
      expect.any(Buffer),
      'application/pdf',
    );
    expect(storageService.getSignedUrl).toHaveBeenCalledWith(`${ORG_ID}/pdf/quotation/${QUOTATION_ID}.pdf`);
    expect(emit).toHaveBeenCalledWith('pdf:ready', {
      documentType: 'quotation',
      documentId: QUOTATION_ID,
      url: 'https://signed.example.com/quotation.pdf',
    });
  });

  it('devis introuvable (NotFoundException) → no-op, pas de relance', async () => {
    quotationService.findOne.mockRejectedValue(new NotFoundException('Devis introuvable.'));

    await expect(
      worker.process(makeJob({ organizationId: ORG_ID, documentId: QUOTATION_ID, requestedBy: 'user-1' })),
    ).resolves.toBeUndefined();
    expect(storageService.upload).not.toHaveBeenCalled();
  });

  it('erreur inattendue → émet pdf:generateFailed PUIS relance pour retry BullMQ', async () => {
    quotationService.findOne.mockRejectedValue(new Error('DB down'));
    const emit = jest.fn();
    const rtWorker = new QuotationPdfWorker(
      quotationService as never,
      pdfService as never,
      storageService as never,
      prisma as never,
      { server: { to: jest.fn().mockReturnValue({ emit }) } } as never,
    );

    await expect(
      rtWorker.process(makeJob({ organizationId: ORG_ID, documentId: QUOTATION_ID, requestedBy: 'user-1' })),
    ).rejects.toThrow('DB down');

    expect(emit).toHaveBeenCalledWith('pdf:generateFailed', {
      documentType: 'quotation',
      documentId: QUOTATION_ID,
    });
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, documentId: QUOTATION_ID, requestedBy: 'user-1' }, 'other.job'),
    );
    expect(quotationService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (documentId manquant) → ignoré sans appeler findOne', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, requestedBy: 'user-1' }));
    expect(quotationService.findOne).not.toHaveBeenCalled();
  });
});
