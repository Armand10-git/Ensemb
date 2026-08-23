import { Decimal } from '@prisma/client/runtime/library';
import { PaymentReceiptEmailWorker } from '../payment-receipt-email.worker';

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
  method: 'CASH',
  change: new Decimal('0'),
  sale: { reference: 'V-2026-0001', client: { name: 'Client Test' } },
};

const FAKE_PAYMENT_PURCHASE = {
  id: PAYMENT_ID,
  organizationId: ORG_ID,
  reference: 'PAA-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  amount: new Decimal('5000'),
  method: 'CASH',
  change: new Decimal('0'),
  purchase: { reference: 'ACH-2026-0001', provider: { name: 'Fournisseur Test' } },
};

describe('PaymentReceiptEmailWorker', () => {
  let prisma: {
    paymentSale: { findUnique: jest.Mock };
    paymentPurchase: { findUnique: jest.Mock };
    organization: { findUnique: jest.Mock };
  };
  let emailService: { sendPaymentReceipt: jest.Mock };
  let worker: PaymentReceiptEmailWorker;

  beforeEach(() => {
    prisma = {
      paymentSale: { findUnique: jest.fn() },
      paymentPurchase: { findUnique: jest.fn() },
      organization: { findUnique: jest.fn().mockResolvedValue({ logoUrl: null, primaryColor: null }) },
    };
    emailService = { sendPaymentReceipt: jest.fn().mockResolvedValue(undefined) };
    worker = new PaymentReceiptEmailWorker(prisma as never, emailService as never, {} as never);
  });

  it('paymentSale.sendEmail : recharge le paiement de vente et envoie le reçu avec le nom du client', async () => {
    prisma.paymentSale.findUnique.mockResolvedValue(FAKE_PAYMENT_SALE);

    await worker.process(
      makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID, to: 'client@example.com' }, 'paymentSale.sendEmail'),
    );

    expect(emailService.sendPaymentReceipt).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: 'client@example.com',
        subject: expect.stringContaining('PAY-2026-0001'),
      }),
    );
    const html = emailService.sendPaymentReceipt.mock.calls[0][1].html as string;
    expect(html).toContain('Client Test');
    expect(html).toContain('V-2026-0001');
  });

  it('paymentPurchase.sendEmail : recharge le paiement d\'achat et envoie le reçu avec le nom du fournisseur', async () => {
    prisma.paymentPurchase.findUnique.mockResolvedValue(FAKE_PAYMENT_PURCHASE);

    await worker.process(
      makeJob(
        { organizationId: ORG_ID, paymentId: PAYMENT_ID, to: 'fournisseur@example.com' },
        'paymentPurchase.sendEmail',
      ),
    );

    expect(emailService.sendPaymentReceipt).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: 'fournisseur@example.com',
        subject: expect.stringContaining('PAA-2026-0001'),
      }),
    );
    const html = emailService.sendPaymentReceipt.mock.calls[0][1].html as string;
    expect(html).toContain('Fournisseur Test');
    expect(html).toContain('ACH-2026-0001');
  });

  it('paiement introuvable ou appartenant à une autre organisation → no-op, pas de relance', async () => {
    prisma.paymentSale.findUnique.mockResolvedValue({ ...FAKE_PAYMENT_SALE, organizationId: 'org-autre' });

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID, to: 'client@example.com' }, 'paymentSale.sendEmail'),
      ),
    ).resolves.toBeUndefined();
    expect(emailService.sendPaymentReceipt).not.toHaveBeenCalled();
  });

  it("erreur inattendue → relancée pour retry BullMQ et notifiée via Socket.io", async () => {
    prisma.paymentSale.findUnique.mockRejectedValue(new Error('DB down'));
    const emit = jest.fn();
    const rtWorker = new PaymentReceiptEmailWorker(
      prisma as never,
      emailService as never,
      { server: { to: jest.fn().mockReturnValue({ emit }) } } as never,
    );

    await expect(
      rtWorker.process(
        makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID, to: 'client@example.com' }, 'paymentSale.sendEmail'),
      ),
    ).rejects.toThrow('DB down');

    expect(emit).toHaveBeenCalledWith(
      'email:sendFailed',
      expect.objectContaining({ jobName: 'paymentSale.sendEmail', reference: PAYMENT_ID }),
    );
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID, to: 'client@example.com' }, 'other.job'),
    );
    expect(prisma.paymentSale.findUnique).not.toHaveBeenCalled();
    expect(prisma.paymentPurchase.findUnique).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, paymentId: PAYMENT_ID }, 'paymentSale.sendEmail'));
    expect(prisma.paymentSale.findUnique).not.toHaveBeenCalled();
  });
});
