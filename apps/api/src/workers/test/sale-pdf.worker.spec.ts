import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { SalePdfWorker } from '../sale-pdf.worker';
import { PdfJobData } from '../../modules/pdf/pdf-job.types';

const SALE_ID = 'sale0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(data: Partial<PdfJobData>, name = 'sale.generatePdf') {
  return { name, data } as never;
}

const FAKE_SALE = {
  id: SALE_ID,
  organizationId: ORG_ID,
  reference: 'V-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'COMPLETED',
  paymentStatus: 'PAID',
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

describe('SalePdfWorker', () => {
  let saleService: { findOne: jest.Mock };
  let pdfService: { render: jest.Mock };
  let storageService: { upload: jest.Mock; getSignedUrl: jest.Mock };
  let prisma: { product: { findMany: jest.Mock }; organization: { findUnique: jest.Mock } };
  let emit: jest.Mock;
  let realtimeGateway: { server: { to: jest.Mock } };
  let worker: SalePdfWorker;

  beforeEach(() => {
    saleService = { findOne: jest.fn() };
    pdfService = { render: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) };
    storageService = {
      upload: jest.fn().mockResolvedValue(`${ORG_ID}/pdf/sale/${SALE_ID}.pdf`),
      getSignedUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed-url'),
    };
    prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'prod-1', name: 'Produit test' }]) },
      organization: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ name: 'Ensemb Org', logoUrl: null, primaryColor: null }),
      },
    };
    emit = jest.fn();
    realtimeGateway = { server: { to: jest.fn().mockReturnValue({ emit }) } };
    worker = new SalePdfWorker(
      saleService as never,
      pdfService as never,
      storageService as never,
      prisma as never,
      realtimeGateway as never,
    );
  });

  it('nom de job inconnu → ignoré, aucun service appelé', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, documentId: SALE_ID }, 'other.job'));
    expect(saleService.findOne).not.toHaveBeenCalled();
    expect(pdfService.render).not.toHaveBeenCalled();
  });

  it('payload incomplet (documentId manquant) → ignoré sans appeler findOne', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID }));
    expect(saleService.findOne).not.toHaveBeenCalled();
  });

  it('succès : recharge la vente, uploade le PDF à la bonne clé et émet pdf:ready', async () => {
    saleService.findOne.mockResolvedValue(FAKE_SALE);

    await worker.process(makeJob({ organizationId: ORG_ID, documentId: SALE_ID, requestedBy: 'user-1' }));

    expect(saleService.findOne).toHaveBeenCalledWith(SALE_ID, ORG_ID);
    expect(pdfService.render).toHaveBeenCalledWith(expect.stringContaining('Produit test'));
    expect(storageService.upload).toHaveBeenCalledWith(
      `${ORG_ID}/pdf/sale/${SALE_ID}.pdf`,
      expect.any(Buffer),
      'application/pdf',
    );
    expect(storageService.getSignedUrl).toHaveBeenCalledWith(`${ORG_ID}/pdf/sale/${SALE_ID}.pdf`);
    expect(realtimeGateway.server.to).toHaveBeenCalledWith(`org:${ORG_ID}`);
    expect(emit).toHaveBeenCalledWith('pdf:ready', {
      documentType: 'sale',
      documentId: SALE_ID,
      url: 'https://cdn.example.com/signed-url',
    });
  });

  it('vente introuvable (NotFoundException) → no-op, pas de relance, pas d\'événement d\'échec', async () => {
    saleService.findOne.mockRejectedValue(new NotFoundException('Vente introuvable.'));

    await expect(
      worker.process(makeJob({ organizationId: ORG_ID, documentId: SALE_ID })),
    ).resolves.toBeUndefined();

    expect(storageService.upload).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('pdf:generateFailed', expect.anything());
  });

  it('erreur inattendue → émet pdf:generateFailed puis relance pour retry BullMQ', async () => {
    saleService.findOne.mockRejectedValue(new Error('DB down'));

    await expect(
      worker.process(makeJob({ organizationId: ORG_ID, documentId: SALE_ID })),
    ).rejects.toThrow('DB down');

    expect(emit).toHaveBeenCalledWith('pdf:generateFailed', {
      documentType: 'sale',
      documentId: SALE_ID,
    });
  });
});
