import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { QuotationEmailWorker } from '../quotation-email.worker';

const QUOTATION_ID = 'quot0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; quotationId?: string; to?: string },
  name = 'quotation.sendEmail',
) {
  return { name, data } as never;
}

const FAKE_QUOTATION = {
  id: QUOTATION_ID,
  organizationId: ORG_ID,
  reference: 'DEV-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'PENDING',
  grandTotal: new Decimal('10000'),
  client: { id: 'client-1', name: 'Client Test' },
  details: [
    {
      productId: 'prod-1',
      quantity: new Decimal('1'),
      price: new Decimal('10000'),
      total: new Decimal('10000'),
    },
  ],
};

describe('QuotationEmailWorker', () => {
  let quotationService: { findOne: jest.Mock };
  let emailService: { sendQuotationSummary: jest.Mock };
  let prisma: { product: { findMany: jest.Mock } };
  let worker: QuotationEmailWorker;

  beforeEach(() => {
    quotationService = { findOne: jest.fn() };
    emailService = { sendQuotationSummary: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'prod-1', name: 'Produit test' }]) },
    };
    worker = new QuotationEmailWorker(
      quotationService as never,
      emailService as never,
      prisma as never,
    );
  });

  it('recharge le devis puis envoie le récapitulatif email avec les bons arguments', async () => {
    quotationService.findOne.mockResolvedValue(FAKE_QUOTATION);

    await worker.process(
      makeJob({ organizationId: ORG_ID, quotationId: QUOTATION_ID, to: 'client@example.com' }),
    );

    expect(quotationService.findOne).toHaveBeenCalledWith(QUOTATION_ID, ORG_ID);
    expect(emailService.sendQuotationSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: 'client@example.com',
        subject: expect.stringContaining('DEV-2026-0001'),
      }),
    );
    const html = emailService.sendQuotationSummary.mock.calls[0][1].html as string;
    expect(html).toContain('Produit test');
  });

  it('devis introuvable (NotFoundException) → no-op, pas de relance', async () => {
    quotationService.findOne.mockRejectedValue(new NotFoundException('Devis introuvable.'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, quotationId: QUOTATION_ID, to: 'client@example.com' }),
      ),
    ).resolves.toBeUndefined();
    expect(emailService.sendQuotationSummary).not.toHaveBeenCalled();
  });

  it('erreur inattendue → relancée pour retry BullMQ', async () => {
    quotationService.findOne.mockRejectedValue(new Error('DB down'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, quotationId: QUOTATION_ID, to: 'client@example.com' }),
      ),
    ).rejects.toThrow('DB down');
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob(
        { organizationId: ORG_ID, quotationId: QUOTATION_ID, to: 'client@example.com' },
        'other.job',
      ),
    );
    expect(quotationService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré sans appeler findOne', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, quotationId: QUOTATION_ID }));
    expect(quotationService.findOne).not.toHaveBeenCalled();
  });
});
