import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { ReturnEmailWorker } from '../return-email.worker';

const RETURN_ID = 'sret0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; returnId?: string; to?: string },
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
  saleId: 'sale-1',
  grandTotal: new Decimal('7000'),
  sale: { reference: 'V-2026-0001' },
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
  purchaseId: 'purchase-1',
  grandTotal: new Decimal('7000'),
  purchase: { reference: 'ACH-2026-0001' },
  details: [
    {
      productId: 'prod-1',
      quantity: new Decimal('1'),
      price: new Decimal('7000'),
      total: new Decimal('7000'),
    },
  ],
};

describe('ReturnEmailWorker', () => {
  let saleReturnService: { findOne: jest.Mock };
  let purchaseReturnService: { findOne: jest.Mock };
  let emailService: { sendReturnSummary: jest.Mock };
  let prisma: {
    product: { findMany: jest.Mock };
    sale: { findUnique: jest.Mock };
    purchase: { findUnique: jest.Mock };
    organization: { findUnique: jest.Mock };
  };
  let worker: ReturnEmailWorker;

  beforeEach(() => {
    saleReturnService = { findOne: jest.fn() };
    purchaseReturnService = { findOne: jest.fn() };
    emailService = { sendReturnSummary: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'prod-1', name: 'Produit test' }]) },
      sale: { findUnique: jest.fn().mockResolvedValue({ client: { name: 'Client Test' } }) },
      purchase: { findUnique: jest.fn().mockResolvedValue({ provider: { name: 'Fournisseur Test' } }) },
      organization: { findUnique: jest.fn().mockResolvedValue({ logoUrl: null, primaryColor: null }) },
    };
    worker = new ReturnEmailWorker(
      saleReturnService as never,
      purchaseReturnService as never,
      emailService as never,
      prisma as never,
      {} as never,
    );
  });

  it('saleReturn.sendEmail : recharge le retour de vente et envoie le récapitulatif avec le nom du client', async () => {
    saleReturnService.findOne.mockResolvedValue(FAKE_SALE_RETURN);

    await worker.process(
      makeJob({ organizationId: ORG_ID, returnId: RETURN_ID, to: 'client@example.com' }, 'saleReturn.sendEmail'),
    );

    expect(saleReturnService.findOne).toHaveBeenCalledWith(RETURN_ID, ORG_ID);
    expect(emailService.sendReturnSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: 'client@example.com',
        subject: expect.stringContaining('RVT-2026-0001'),
      }),
    );
    const html = emailService.sendReturnSummary.mock.calls[0][1].html as string;
    expect(html).toContain('Client Test');
    expect(html).toContain('Produit test');
  });

  it('purchaseReturn.sendEmail : recharge le retour fournisseur et envoie le récapitulatif avec le nom du fournisseur', async () => {
    purchaseReturnService.findOne.mockResolvedValue(FAKE_PURCHASE_RETURN);

    await worker.process(
      makeJob(
        { organizationId: ORG_ID, returnId: RETURN_ID, to: 'fournisseur@example.com' },
        'purchaseReturn.sendEmail',
      ),
    );

    expect(purchaseReturnService.findOne).toHaveBeenCalledWith(RETURN_ID, ORG_ID);
    expect(emailService.sendReturnSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: 'fournisseur@example.com',
        subject: expect.stringContaining('RAC-2026-0001'),
      }),
    );
    const html = emailService.sendReturnSummary.mock.calls[0][1].html as string;
    expect(html).toContain('Fournisseur Test');
  });

  it('retour introuvable (NotFoundException) → no-op, pas de relance', async () => {
    saleReturnService.findOne.mockRejectedValue(new NotFoundException('Retour introuvable.'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, returnId: RETURN_ID, to: 'client@example.com' }, 'saleReturn.sendEmail'),
      ),
    ).resolves.toBeUndefined();
    expect(emailService.sendReturnSummary).not.toHaveBeenCalled();
  });

  it("erreur inattendue → relancée pour retry BullMQ et notifiée via Socket.io", async () => {
    saleReturnService.findOne.mockRejectedValue(new Error('DB down'));
    const emit = jest.fn();
    const rtWorker = new ReturnEmailWorker(
      saleReturnService as never,
      purchaseReturnService as never,
      emailService as never,
      prisma as never,
      { server: { to: jest.fn().mockReturnValue({ emit }) } } as never,
    );

    await expect(
      rtWorker.process(
        makeJob({ organizationId: ORG_ID, returnId: RETURN_ID, to: 'client@example.com' }, 'saleReturn.sendEmail'),
      ),
    ).rejects.toThrow('DB down');

    expect(emit).toHaveBeenCalledWith(
      'email:sendFailed',
      expect.objectContaining({ jobName: 'saleReturn.sendEmail', reference: RETURN_ID }),
    );
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, returnId: RETURN_ID, to: 'client@example.com' }, 'other.job'),
    );
    expect(saleReturnService.findOne).not.toHaveBeenCalled();
    expect(purchaseReturnService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, returnId: RETURN_ID }, 'saleReturn.sendEmail'));
    expect(saleReturnService.findOne).not.toHaveBeenCalled();
  });
});
