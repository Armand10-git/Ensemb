import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PurchaseEmailWorker } from '../purchase-email.worker';

const PURCHASE_ID = 'purc0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { organizationId?: string; purchaseId?: string; to?: string },
  name = 'purchase.sendEmail',
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
  provider: { id: 'prov-1', name: 'Fournisseur Test' },
  details: [
    {
      productId: 'prod-1',
      quantity: new Decimal('1'),
      price: new Decimal('10000'),
      total: new Decimal('10000'),
    },
  ],
};

describe('PurchaseEmailWorker', () => {
  let purchaseService: { findOne: jest.Mock };
  let emailService: { sendPurchaseSummary: jest.Mock };
  let prisma: { product: { findMany: jest.Mock }; organization: { findUnique: jest.Mock } };
  let worker: PurchaseEmailWorker;

  beforeEach(() => {
    purchaseService = { findOne: jest.fn() };
    emailService = { sendPurchaseSummary: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'prod-1', name: 'Produit test' }]) },
      organization: { findUnique: jest.fn().mockResolvedValue({ logoUrl: null, primaryColor: null }) },
    };
    worker = new PurchaseEmailWorker(
      purchaseService as never,
      emailService as never,
      prisma as never,
      {} as never,
    );
  });

  it("recharge l'achat puis envoie le récapitulatif email avec les bons arguments", async () => {
    purchaseService.findOne.mockResolvedValue(FAKE_PURCHASE);

    await worker.process(
      makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: 'fournisseur@example.com' }),
    );

    expect(purchaseService.findOne).toHaveBeenCalledWith(PURCHASE_ID, ORG_ID);
    expect(emailService.sendPurchaseSummary).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        to: 'fournisseur@example.com',
        subject: expect.stringContaining('ACH-2026-0001'),
      }),
    );
    const html = emailService.sendPurchaseSummary.mock.calls[0][1].html as string;
    expect(html).toContain('Produit test');
    expect(html).toContain('Fournisseur Test');
    expect(html).toContain('#2FA75E');
  });

  it('applique le logo/couleur de l\'organisation au récapitulatif', async () => {
    purchaseService.findOne.mockResolvedValue(FAKE_PURCHASE);
    prisma.organization.findUnique.mockResolvedValue({
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#3B82F6',
    });

    await worker.process(
      makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: 'fournisseur@example.com' }),
    );

    const html = emailService.sendPurchaseSummary.mock.calls[0][1].html as string;
    expect(html).toContain('https://cdn.example.com/logo.png');
    expect(html).toContain('#3B82F6');
  });

  it('achat introuvable (NotFoundException) → no-op, pas de relance', async () => {
    purchaseService.findOne.mockRejectedValue(new NotFoundException('Achat introuvable.'));

    await expect(
      worker.process(
        makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: 'fournisseur@example.com' }),
      ),
    ).resolves.toBeUndefined();
    expect(emailService.sendPurchaseSummary).not.toHaveBeenCalled();
  });

  it("erreur inattendue → relancée pour retry BullMQ et notifiée via Socket.io", async () => {
    purchaseService.findOne.mockRejectedValue(new Error('DB down'));
    const emit = jest.fn();
    const rtWorker = new PurchaseEmailWorker(
      purchaseService as never,
      emailService as never,
      prisma as never,
      { server: { to: jest.fn().mockReturnValue({ emit }) } } as never,
    );

    await expect(
      rtWorker.process(
        makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: 'fournisseur@example.com' }),
      ),
    ).rejects.toThrow('DB down');

    expect(emit).toHaveBeenCalledWith(
      'email:sendFailed',
      expect.objectContaining({ jobName: 'purchase.sendEmail', reference: PURCHASE_ID }),
    );
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(
      makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID, to: 'fournisseur@example.com' }, 'other.job'),
    );
    expect(purchaseService.findOne).not.toHaveBeenCalled();
  });

  it('payload incomplet (to manquant) → ignoré sans appeler findOne', async () => {
    await worker.process(makeJob({ organizationId: ORG_ID, purchaseId: PURCHASE_ID }));
    expect(purchaseService.findOne).not.toHaveBeenCalled();
  });
});
