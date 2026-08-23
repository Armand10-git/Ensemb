import { SaleOnlinePaymentExpirationWorker } from '../sale-online-payment-expiration.worker';

const INTENT_ID = 'inte0001-0000-0000-0000-000000000001';
const ORG_ID = 'aaaa0000-0000-0000-0000-000000000001';

function makeJob(
  data: { intentId?: string; organizationId?: string },
  name = 'sale.expireOnlinePayment',
) {
  return { name, data } as never;
}

describe('SaleOnlinePaymentExpirationWorker', () => {
  let saleOnlinePaymentService: { expirePayment: jest.Mock };
  let auditService: { create: jest.Mock };
  let worker: SaleOnlinePaymentExpirationWorker;

  beforeEach(() => {
    saleOnlinePaymentService = { expirePayment: jest.fn() };
    auditService = { create: jest.fn().mockResolvedValue(undefined) };
    worker = new SaleOnlinePaymentExpirationWorker(
      saleOnlinePaymentService as never,
      auditService as never,
    );
  });

  it('job traité normalement → appelle expirePayment(), journalise AuditLog SYSTEM', async () => {
    saleOnlinePaymentService.expirePayment.mockResolvedValue(undefined);

    await worker.process(makeJob({ intentId: INTENT_ID, organizationId: ORG_ID }));

    expect(saleOnlinePaymentService.expirePayment).toHaveBeenCalledWith(ORG_ID, INTENT_ID);
    expect(auditService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'sale.expireOnlinePayment',
        entity: 'OnlinePaymentIntent',
        entityId: INTENT_ID,
      }),
    );
  });

  it(
    'intention déjà résolue (CONFIRMED/EXPIRED) → expirePayment() résout silencieusement ' +
      '(no-op interne au service), le job se termine sans erreur',
    async () => {
      // expirePayment() est lui-même un no-op idempotent (jamais d'exception) — le worker ne
      // peut pas distinguer une expiration réelle d'un no-op interne, mais il ne doit jamais
      // planter ni relancer dans ce cas.
      saleOnlinePaymentService.expirePayment.mockResolvedValue(undefined);

      await expect(
        worker.process(makeJob({ intentId: INTENT_ID, organizationId: ORG_ID })),
      ).resolves.toBeUndefined();

      expect(saleOnlinePaymentService.expirePayment).toHaveBeenCalledTimes(1);
    },
  );

  it('rejeu du job après résolution (retry BullMQ) → toujours no-op, jamais d\'erreur', async () => {
    saleOnlinePaymentService.expirePayment.mockResolvedValue(undefined);

    await worker.process(makeJob({ intentId: INTENT_ID, organizationId: ORG_ID }));
    await worker.process(makeJob({ intentId: INTENT_ID, organizationId: ORG_ID }));

    expect(saleOnlinePaymentService.expirePayment).toHaveBeenCalledTimes(2);
    expect(auditService.create).toHaveBeenCalledTimes(2);
  });

  it('erreur inattendue (DB indisponible) → relance pour retry BullMQ', async () => {
    saleOnlinePaymentService.expirePayment.mockRejectedValue(new Error('DB indisponible'));

    await expect(
      worker.process(makeJob({ intentId: INTENT_ID, organizationId: ORG_ID })),
    ).rejects.toThrow('DB indisponible');
    expect(auditService.create).not.toHaveBeenCalled();
  });

  it('job sans intentId/organizationId → ignoré sans appeler expirePayment()', async () => {
    await worker.process(makeJob({}));

    expect(saleOnlinePaymentService.expirePayment).not.toHaveBeenCalled();
  });

  it('nom de job inconnu → ignoré', async () => {
    await worker.process(makeJob({ intentId: INTENT_ID, organizationId: ORG_ID }, 'other.job'));

    expect(saleOnlinePaymentService.expirePayment).not.toHaveBeenCalled();
  });
});
