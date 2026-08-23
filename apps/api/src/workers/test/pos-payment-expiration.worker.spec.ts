import { BadRequestException, ConflictException } from '@nestjs/common';
import { PosPaymentExpirationWorker } from '../pos-payment-expiration.worker';

const SALE_ID = 'sale0001-0000-0000-0000-000000000001';
const ORG_ID  = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(data: { saleId?: string; organizationId?: string }, name = 'pos.expirePayment') {
  return { name, data } as never;
}

describe('PosPaymentExpirationWorker', () => {
  let saleService: { expireAwaitingPayment: jest.Mock };
  let auditService: { create: jest.Mock };
  let worker: PosPaymentExpirationWorker;

  beforeEach(() => {
    saleService = { expireAwaitingPayment: jest.fn() };
    auditService = { create: jest.fn().mockResolvedValue(undefined) };
    worker = new PosPaymentExpirationWorker(saleService as never, auditService as never);
  });

  it('AWAITING_PAYMENT et délai écoulé → appelle SaleService.expireAwaitingPayment(), journalise AuditLog SYSTEM', async () => {
    saleService.expireAwaitingPayment.mockResolvedValue({
      status: 'CANCELLED',
      cancelReason: 'Expiration du délai de paiement mobile money',
    });

    await worker.process(makeJob({ saleId: SALE_ID, organizationId: ORG_ID }));

    expect(saleService.expireAwaitingPayment).toHaveBeenCalledWith(
      SALE_ID,
      ORG_ID,
      'Expiration du délai de paiement mobile money',
    );
    expect(auditService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'pos.expirePayment',
        entity: 'Sale',
        entityId: SALE_ID,
      }),
    );
  });

  it('vente déjà résolue (COMPLETED/CANCELLED, BadRequestException) → no-op, pas de relance', async () => {
    saleService.expireAwaitingPayment.mockRejectedValue(
      new BadRequestException('Seule une vente en attente de paiement (AWAITING_PAYMENT) peut expirer.'),
    );

    await expect(
      worker.process(makeJob({ saleId: SALE_ID, organizationId: ORG_ID })),
    ).resolves.toBeUndefined();
    expect(auditService.create).not.toHaveBeenCalled();
  });

  it('conflit de concurrence (ConflictException) → relance l\'erreur pour retry BullMQ', async () => {
    saleService.expireAwaitingPayment.mockRejectedValue(new ConflictException('Conflit de version'));

    await expect(
      worker.process(makeJob({ saleId: SALE_ID, organizationId: ORG_ID })),
    ).rejects.toThrow(ConflictException);
  });

  it('job sans saleId/organizationId → ignoré sans appeler expireAwaitingPayment()', async () => {
    await worker.process(makeJob({}));

    expect(saleService.expireAwaitingPayment).not.toHaveBeenCalled();
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(makeJob({ saleId: SALE_ID, organizationId: ORG_ID }, 'other.job'));

    expect(saleService.expireAwaitingPayment).not.toHaveBeenCalled();
  });
});
