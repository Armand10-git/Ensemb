import { Decimal } from '@prisma/client/runtime/library';
import { PaymentReceiptSmsWorker } from '../payment-receipt-sms.worker';

const PAYMENT_ID = 'pay00001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; paymentId?: string; to?: string },
  name: string,
) {
  return { name, data } as never;
}

const FAKE_PAYMENT_SALE = {
  id: PAYMENT_ID,
  organizationId: ORG_ID,
  reference: 'PAY-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  amount: new Decimal('5000'),
  sale: { reference: 'V-2026-0001' },
};

const FAKE_PAYMENT_PURCHASE = {
  id: PAYMENT_ID,
  organizationId: ORG_ID,
  reference: 'PAA-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  amount: new Decimal('5000'),
  purchase: { reference: 'ACH-2026-0001' },
};

describe('PaymentReceiptSmsWorker', () => {
  let prisma: {
    paymentSale: { findUnique: jest.Mock };
    paymentPurchase: { findUnique: jest.Mock };
  };
  let smsService: { sendPaymentReceipt: jest.Mock };
  let worker: PaymentReceiptSmsWorker;

  beforeEach(() => {
    prisma = {
      paymentSale: { findUnique: jest.fn() },
      paymentPurchase: { findUnique: jest.fn() },
    };
    smsService = { sendPaymentReceipt: jest.fn().mockResolvedValue(undefined) };
    worker = new PaymentReceiptSmsWorker(prisma as never, smsService as never);
  });

  it('paymentSale.sendSms : recharge le paiement de vente et envoie le reçu SMS', async () => {
    prisma.paymentSale.findUnique.mockResolvedValue(FAKE_PAYMENT_SALE);

    await worker.process(
      makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID, to: '+237600000000' }, 'paymentSale.sendSms'),
    );

    expect(smsService.sendPaymentReceipt).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: '+237600000000',
        body: expect.stringContaining('PAY-2026-0001'),
      }),
    );
  });

  it("paymentPurchase.sendSms : recharge le paiement d'achat et envoie le reçu SMS", async () => {
    prisma.paymentPurchase.findUnique.mockResolvedValue(FAKE_PAYMENT_PURCHASE);

    await worker.process(
      makeJob(
        { organizationId: ORG_ID, paymentId: PAYMENT_ID, to: '+237600000000' },
        'paymentPurchase.sendSms',
      ),
    );

    expect(smsService.sendPaymentReceipt).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: '+237600000000',
        body: expect.stringContaining('PAA-2026-0001'),
      }),
    );
  });

  it('paiement introuvable ou appartenant à une autre organisation → no-op, pas de relance', async () => {
    prisma.paymentSale.findUnique.mockResolvedValue({ ...FAKE_PAYMENT_SALE, organizationId: 'org-autre' });

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID, to: '+237600000000' }, 'paymentSale.sendSms'),
      ),
    ).resolves.toBeUndefined();
    expect(smsService.sendPaymentReceipt).not.toHaveBeenCalled();
  });

  it('erreur inattendue → relancée pour retry BullMQ', async () => {
    prisma.paymentSale.findUnique.mockRejectedValue(new Error('DB down'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID, to: '+237600000000' }, 'paymentSale.sendSms'),
      ),
    ).rejects.toThrow('DB down');
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID, to: '+237600000000' }, 'other.job'),
    );
    expect(prisma.paymentSale.findUnique).not.toHaveBeenCalled();
    expect(prisma.paymentPurchase.findUnique).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID }, 'paymentSale.sendSms'));
    expect(prisma.paymentSale.findUnique).not.toHaveBeenCalled();
  });
});
