import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PurchaseSmsWorker } from '../purchase-sms.worker';

const PURCHASE_ID = 'purc0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; purchaseId?: string; to?: string },
  name = 'purchase.sendSms',
) {
  return { name, data } as never;
}

const FAKE_PURCHASE = {
  id: PURCHASE_ID,
  organizationId: ORG_ID,
  reference: 'ACH-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  paymentStatus: 'PAID',
  grandTotal: new Decimal('10000'),
  provider: { id: 'provider-1', name: 'Fournisseur Test' },
  details: [
    {
      productId: 'prod-1',
      quantity: new Decimal('1'),
      price: new Decimal('10000'),
      total: new Decimal('10000'),
    },
  ],
};

describe('PurchaseSmsWorker', () => {
  let purchaseService: { findOne: jest.Mock };
  let smsService: { sendPurchaseSummary: jest.Mock };
  let worker: PurchaseSmsWorker;

  beforeEach(() => {
    purchaseService = { findOne: jest.fn() };
    smsService = { sendPurchaseSummary: jest.fn().mockResolvedValue(undefined) };
    worker = new PurchaseSmsWorker(purchaseService as never, smsService as never);
  });

  it("recharge l'achat puis envoie le récapitulatif SMS avec les bons arguments", async () => {
    purchaseService.findOne.mockResolvedValue(FAKE_PURCHASE);

    await worker.process(
      makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: '+237600000000' }),
    );

    expect(purchaseService.findOne).toHaveBeenCalledWith(PURCHASE_ID, ORG_ID);
    expect(smsService.sendPurchaseSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: '+237600000000',
        body: expect.stringContaining('ACH-2026-0001'),
      }),
    );
  });

  it('achat introuvable (NotFoundException) → no-op, pas de relance', async () => {
    purchaseService.findOne.mockRejectedValue(new NotFoundException('Achat introuvable.'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: '+237600000000' }),
      ),
    ).resolves.toBeUndefined();
    expect(smsService.sendPurchaseSummary).not.toHaveBeenCalled();
  });

  it('erreur inattendue → relancée pour retry BullMQ', async () => {
    purchaseService.findOne.mockRejectedValue(new Error('DB down'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: '+237600000000' }),
      ),
    ).rejects.toThrow('DB down');
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: '+237600000000' }, 'other.job'),
    );
    expect(purchaseService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré sans appeler findOne', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID }));
    expect(purchaseService.findOne).not.toHaveBeenCalled();
  });
});
