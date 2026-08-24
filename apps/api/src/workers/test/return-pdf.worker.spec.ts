import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { ReturnPdfWorker } from '../return-pdf.worker';

const RETURN_ID = 'sret0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; documentId?: string; requestedBy?: string },
  name: string,
) {
  return { name, data } as never;
}

const FAKE_SALE_RETURN = {
  id: RETURN_ID,
  organizationId: ORG_ID,
  reference: 'RVT-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  saleId: 'sale-1',
  discount: null,
  taxAmount: null,
  shipping: null,
  grandTotal: new Decimal('7000'),
  sale: { reference: 'V-2026-0001' },
  warehouse: { id: 'wh-1', name: 'Entrepôt Central' },
  details: [
    {
      productId: 'prod-1',
      quantity: new Decimal('1'),
      price: new Decimal('7000'),
      total: new Decimal('7000'),
    },
  ],
};

const FAKE_PURCHASE_RETURN = {
  id: RETURN_ID,
  organizationId: ORG_ID,
  reference: 'RAC-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  purchaseId: 'purchase-1',
  discount: null,
  taxAmount: null,
  shipping: null,
  grandTotal: new Decimal('7000'),
  purchase: { reference: 'ACH-2026-0001' },
  warehouse: { id: 'wh-1', name: 'Entrepôt Central' },
  details: [
    {
      productId: 'prod-1',
      quantity: new Decimal('1'),
      price: new Decimal('7000'),
      total: new Decimal('7000'),
    },
  ],
};

describe('ReturnPdfWorker', () => {
  let saleReturnService: { findOne: jest.Mock };
  let purchaseReturnService: { findOne: jest.Mock };
  let pdfService: { render: jest.Mock };
  let storageService: { upload: jest.Mock; getSignedUrl: jest.Mock };
  let prisma: {
    product: { findMany: jest.Mock };
    sale: { findUnique: jest.Mock };
    purchase: { findUnique: jest.Mock };
    organization: { findUnique: jest.Mock };
  };
  let worker: ReturnPdfWorker;

  beforeEach(() => {
    saleReturnService = { findOne: jest.fn() };
    purchaseReturnService = { findOne: jest.fn() };
    pdfService = { render: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')) };
    storageService = {
      upload: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest.fn().mockResolvedValue('https://signed.example.com/return.pdf'),
    };
    prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'prod-1', name: 'Produit test' }]) },
      sale: { findUnique: jest.fn().mockResolvedValue({ client: { name: 'Client Test' } }) },
      purchase: { findUnique: jest.fn().mockResolvedValue({ provider: { name: 'Fournisseur Test' } }) },
      organization: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Boutique Ensemb', logoUrl: null, primaryColor: null }),
      },
    };
    worker = new ReturnPdfWorker(
      saleReturnService as never,
      purchaseReturnService as never,
      pdfService as never,
      storageService as never,
      prisma as never,
      {} as never,
    );
  });

  it('saleReturn.generatePdf : recharge le retour de vente, rend le PDF avec le nom du client, uploade et émet pdf:ready', async () => {
    saleReturnService.findOne.mockResolvedValue(FAKE_SALE_RETURN);
    const emit = jest.fn();
    const rtWorker = new ReturnPdfWorker(
      saleReturnService as never,
      purchaseReturnService as never,
      pdfService as never,
      storageService as never,
      prisma as never,
      { server: { to: jest.fn().mockReturnValue({ emit }) } } as never,
    );

    await rtWorker.process(
      makeJob({ organizationId: ORG_ID, documentId: RETURN_ID, requestedBy: 'user-1' }, 'saleReturn.generatePdf'),
    );

    expect(saleReturnService.findOne).toHaveBeenCalledWith(RETURN_ID, ORG_ID);
    const html = pdfService.render.mock.calls[0][0] as string;
    expect(html).toContain('Client Test');
    expect(html).toContain('Produit test');

    expect(storageService.upload).toHaveBeenCalledWith(
      `${ORG_ID}/pdf/saleReturn/${RETURN_ID}.pdf`,
      expect.any(Buffer),
      'application/pdf',
    );
    expect(emit).toHaveBeenCalledWith('pdf:ready', {
      documentType: 'saleReturn',
      documentId: RETURN_ID,
      url: 'https://signed.example.com/return.pdf',
    });
  });

  it('purchaseReturn.generatePdf : recharge le retour fournisseur, rend le PDF avec le nom du fournisseur, uploade avec la bonne clé', async () => {
    purchaseReturnService.findOne.mockResolvedValue(FAKE_PURCHASE_RETURN);
    const emit = jest.fn();
    const rtWorker = new ReturnPdfWorker(
      saleReturnService as never,
      purchaseReturnService as never,
      pdfService as never,
      storageService as never,
      prisma as never,
      { server: { to: jest.fn().mockReturnValue({ emit }) } } as never,
    );

    await rtWorker.process(
      makeJob(
        { organizationId: ORG_ID, documentId: RETURN_ID, requestedBy: 'user-1' },
        'purchaseReturn.generatePdf',
      ),
    );

    expect(purchaseReturnService.findOne).toHaveBeenCalledWith(RETURN_ID, ORG_ID);
    const html = pdfService.render.mock.calls[0][0] as string;
    expect(html).toContain('Fournisseur Test');

    expect(storageService.upload).toHaveBeenCalledWith(
      `${ORG_ID}/pdf/purchaseReturn/${RETURN_ID}.pdf`,
      expect.any(Buffer),
      'application/pdf',
    );
    expect(emit).toHaveBeenCalledWith('pdf:ready', {
      documentType: 'purchaseReturn',
      documentId: RETURN_ID,
      url: 'https://signed.example.com/return.pdf',
    });
  });

  it('retour introuvable (NotFoundException) → no-op, pas de relance', async () => {
    saleReturnService.findOne.mockRejectedValue(new NotFoundException('Retour introuvable.'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, documentId: RETURN_ID, requestedBy: 'user-1' }, 'saleReturn.generatePdf'),
      ),
    ).resolves.toBeUndefined();
    expect(storageService.upload).not.toHaveBeenCalled();
  });

  it('erreur inattendue → émet pdf:generateFailed PUIS relance pour retry BullMQ', async () => {
    saleReturnService.findOne.mockRejectedValue(new Error('DB down'));
    const emit = jest.fn();
    const rtWorker = new ReturnPdfWorker(
      saleReturnService as never,
      purchaseReturnService as never,
      pdfService as never,
      storageService as never,
      prisma as never,
      { server: { to: jest.fn().mockReturnValue({ emit }) } } as never,
    );

    await expect(
      rtWorker.process(
        makeJob({ organizationId: ORG_ID, documentId: RETURN_ID, requestedBy: 'user-1' }, 'saleReturn.generatePdf'),
      ),
    ).rejects.toThrow('DB down');

    expect(emit).toHaveBeenCalledWith('pdf:generateFailed', {
      documentType: 'saleReturn',
      documentId: RETURN_ID,
    });
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, documentId: RETURN_ID, requestedBy: 'user-1' }, 'other.job'),
    );
    expect(saleReturnService.findOne).not.toHaveBeenCalled();
    expect(purchaseReturnService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (documentId manquant) → ignoré', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, requestedBy: 'user-1' }, 'saleReturn.generatePdf'));
    expect(saleReturnService.findOne).not.toHaveBeenCalled();
  });
});
