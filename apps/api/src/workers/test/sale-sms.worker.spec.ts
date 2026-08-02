import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { SaleSmsWorker } from '../sale-sms.worker';

const SALE_ID = 'sale0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; saleId?: string; to?: string },
  name = 'sale.sendSms',
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

describe('SaleSmsWorker', () => {
  let saleService: { findOne: jest.Mock };
  let smsService: { sendSaleSummary: jest.Mock };
  let worker: SaleSmsWorker;

  beforeEach(() => {
    saleService = { findOne: jest.fn() };
    smsService = { sendSaleSummary: jest.fn().mockResolvedValue(undefined) };
    worker = new SaleSmsWorker(saleService as never, smsService as never);
  });

  it('recharge la vente puis envoie le récapitulatif SMS avec les bons arguments', async () => {
    saleService.findOne.mockResolvedValue(FAKE_SALE);

    await worker.process(
      makeJob({ organizationId: ORG_ID, saleId: SALE_ID, to: '+237600000000' }),
    );

    expect(saleService.findOne).toHaveBeenCalledWith(SALE_ID, ORG_ID);
    expect(smsService.sendSaleSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: '+237600000000',
        body: expect.stringContaining('V-2026-0001'),
      }),
    );
  });

  it('vente introuvable (NotFoundException) → no-op, pas de relance', async () => {
    saleService.findOne.mockRejectedValue(new NotFoundException('Vente introuvable.'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, saleId: SALE_ID, to: '+237600000000' }),
      ),
    ).resolves.toBeUndefined();
    expect(smsService.sendSaleSummary).not.toHaveBeenCalled();
  });

  it('erreur inattendue → relancée pour retry BullMQ', async () => {
    saleService.findOne.mockRejectedValue(new Error('DB down'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, saleId: SALE_ID, to: '+237600000000' }),
      ),
    ).rejects.toThrow('DB down');
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, saleId: SALE_ID, to: '+237600000000' }, 'other.job'),
    );
    expect(saleService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré sans appeler findOne', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, saleId: SALE_ID }));
    expect(saleService.findOne).not.toHaveBeenCalled();
  });
});
