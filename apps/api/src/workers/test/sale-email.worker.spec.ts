import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { SaleEmailWorker } from '../sale-email.worker';

const SALE_ID = 'sale0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; saleId?: string; to?: string },
  name = 'sale.sendEmail',
) {
  return { name, data } as never;
}

const FAKE_SALE = {
  id: SALE_ID,
  organizationId: ORG_ID,
  reference: 'V-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  paymentStatus: 'PAID',
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

describe('SaleEmailWorker', () => {
  let saleService: { findOne: jest.Mock };
  let emailService: { sendSaleSummary: jest.Mock };
  let prisma: { product: { findMany: jest.Mock } };
  let worker: SaleEmailWorker;

  beforeEach(() => {
    saleService = { findOne: jest.fn() };
    emailService = { sendSaleSummary: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'prod-1', name: 'Produit test' }]) },
    };
    worker = new SaleEmailWorker(saleService as never, emailService as never, prisma as never);
  });

  it('recharge la vente puis envoie le récapitulatif email avec les bons arguments', async () => {
    saleService.findOne.mockResolvedValue(FAKE_SALE);

    await worker.process(
      makeJob({ organizationId: ORG_ID, saleId: SALE_ID, to: 'client@example.com' }),
    );

    expect(saleService.findOne).toHaveBeenCalledWith(SALE_ID, ORG_ID);
    expect(emailService.sendSaleSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: 'client@example.com',
        subject: expect.stringContaining('V-2026-0001'),
      }),
    );
    const html = emailService.sendSaleSummary.mock.calls[0][1].html as string;
    expect(html).toContain('Produit test');
  });

  it('vente introuvable (NotFoundException) → no-op, pas de relance', async () => {
    saleService.findOne.mockRejectedValue(new NotFoundException('Vente introuvable.'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, saleId: SALE_ID, to: 'client@example.com' }),
      ),
    ).resolves.toBeUndefined();
    expect(emailService.sendSaleSummary).not.toHaveBeenCalled();
  });

  it('erreur inattendue → relancée pour retry BullMQ', async () => {
    saleService.findOne.mockRejectedValue(new Error('DB down'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, saleId: SALE_ID, to: 'client@example.com' }),
      ),
    ).rejects.toThrow('DB down');
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, saleId: SALE_ID, to: 'client@example.com' }, 'other.job'),
    );
    expect(saleService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré sans appeler findOne', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, saleId: SALE_ID }));
    expect(saleService.findOne).not.toHaveBeenCalled();
  });
});
