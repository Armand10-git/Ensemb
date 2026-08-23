import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { ReturnSmsWorker } from '../return-sms.worker';

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

describe('ReturnSmsWorker', () => {
  let saleReturnService: { findOne: jest.Mock };
  let purchaseReturnService: { findOne: jest.Mock };
  let smsService: { sendReturnSummary: jest.Mock };
  let worker: ReturnSmsWorker;

  beforeEach(() => {
    saleReturnService = { findOne: jest.fn() };
    purchaseReturnService = { findOne: jest.fn() };
    smsService = { sendReturnSummary: jest.fn().mockResolvedValue(undefined) };
    worker = new ReturnSmsWorker(
      saleReturnService as never,
      purchaseReturnService as never,
      smsService as never,
    );
  });

  it('saleReturn.sendSms : recharge le retour de vente et envoie le récapitulatif SMS', async () => {
    saleReturnService.findOne.mockResolvedValue(FAKE_SALE_RETURN);

    await worker.process(
      makeJob({ organizationId: ORG_ID, returnId: RETURN_ID, to: '+237600000000' }, 'saleReturn.sendSms'),
    );

    expect(saleReturnService.findOne).toHaveBeenCalledWith(RETURN_ID, ORG_ID);
    expect(smsService.sendReturnSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: '+237600000000',
        body: expect.stringContaining('RVT-2026-0001'),
      }),
    );
  });

  it('purchaseReturn.sendSms : recharge le retour fournisseur et envoie le récapitulatif SMS', async () => {
    purchaseReturnService.findOne.mockResolvedValue(FAKE_PURCHASE_RETURN);

    await worker.process(
      makeJob(
        { organizationId: ORG_ID, returnId: RETURN_ID, to: '+237600000000' },
        'purchaseReturn.sendSms',
      ),
    );

    expect(purchaseReturnService.findOne).toHaveBeenCalledWith(RETURN_ID, ORG_ID);
    expect(smsService.sendReturnSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: '+237600000000',
        body: expect.stringContaining('RAC-2026-0001'),
      }),
    );
  });

  it('retour introuvable (NotFoundException) → no-op, pas de relance', async () => {
    saleReturnService.findOne.mockRejectedValue(new NotFoundException('Retour introuvable.'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, returnId: RETURN_ID, to: '+237600000000' }, 'saleReturn.sendSms'),
      ),
    ).resolves.toBeUndefined();
    expect(smsService.sendReturnSummary).not.toHaveBeenCalled();
  });

  it('erreur inattendue → relancée pour retry BullMQ', async () => {
    saleReturnService.findOne.mockRejectedValue(new Error('DB down'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, returnId: RETURN_ID, to: '+237600000000' }, 'saleReturn.sendSms'),
      ),
    ).rejects.toThrow('DB down');
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, returnId: RETURN_ID, to: '+237600000000' }, 'other.job'),
    );
    expect(saleReturnService.findOne).not.toHaveBeenCalled();
    expect(purchaseReturnService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, returnId: RETURN_ID }, 'saleReturn.sendSms'));
    expect(saleReturnService.findOne).not.toHaveBeenCalled();
  });
});
