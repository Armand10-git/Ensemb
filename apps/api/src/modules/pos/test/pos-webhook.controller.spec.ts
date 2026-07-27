import { UnauthorizedException } from '@nestjs/common';
import { PosWebhookController } from '../pos-webhook.controller';

const ORG_ID  = 'aaaaaaaa-0000-4000-a000-000000000001';
const SALE_ID = 'sale0001-0000-0000-0000-000000000001';
const PROV_ID = 'evt-idempotence-xyz';

const POS_PAYLOAD = {
  type: 'payment.success',
  providerEventId: PROV_ID,
  saleId: SALE_ID,
};

const makeRaw = (obj: object) => Buffer.from(JSON.stringify(obj), 'utf8');
const makeReq = (rawBody: Buffer, sig = 'valid-sig') => ({
  rawBody,
  headers: { 'x-aggregator-signature': sig },
});

const P2002 = Object.assign(new Error('Unique constraint'), { code: 'P2002' });

const makeWebhookEvent = (dupOnSecondCall = false) => {
  let calls = 0;
  return {
    create: jest.fn().mockImplementation(async () => {
      calls++;
      if (dupOnSecondCall && calls > 1) throw P2002;
      return { id: `evt-uuid-${calls}` };
    }),
    update: jest.fn().mockResolvedValue({}),
  };
};

const makeController = (opts: {
  signatureValid?: boolean;
  dupOnSecondCall?: boolean;
  orgExists?: boolean;
  confirmMobileMoneyPayment?: jest.Mock;
} = {}) => {
  const aggregator = { verifyWebhookSignature: jest.fn().mockReturnValue(opts.signatureValid ?? true) };
  const webhookEvent = makeWebhookEvent(opts.dupOnSecondCall ?? false);
  const prisma = {
    webhookEvent,
    organization: {
      findUnique: jest.fn().mockResolvedValue((opts.orgExists ?? true) ? { id: ORG_ID } : null),
    },
  };
  const confirmMobileMoneyPayment = opts.confirmMobileMoneyPayment ?? jest.fn().mockResolvedValue(undefined);
  const posService = { confirmMobileMoneyPayment };
  const ctrl = new PosWebhookController(aggregator as never, prisma as never, posService as never);
  return { ctrl, aggregator, prisma, webhookEvent, posService, confirmMobileMoneyPayment };
};

describe('PosWebhookController', () => {
  it('premier appel : WebhookEvent créé (provider = "pos-aggregator") avec saleId', async () => {
    const { ctrl, webhookEvent } = makeController();

    const result = await ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD)) as never);

    expect(result).toEqual({ received: true });
    expect(webhookEvent.create).toHaveBeenCalledTimes(1);
    const createArgs = (webhookEvent.create as jest.Mock).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.provider).toBe('pos-aggregator');
    expect(createArgs.data.organizationId).toBe(ORG_ID);
    expect(createArgs.data.saleId).toBe(SALE_ID);
  });

  it('payment.success avec saleId → appelle PosService.confirmMobileMoneyPayment', async () => {
    const confirmMobileMoneyPayment = jest.fn().mockResolvedValue(undefined);
    const { ctrl } = makeController({ confirmMobileMoneyPayment });

    await ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD)) as never);

    expect(confirmMobileMoneyPayment).toHaveBeenCalledWith(ORG_ID, SALE_ID);
  });

  it('payment.success sans saleId → ignoré, PosService jamais appelé', async () => {
    const confirmMobileMoneyPayment = jest.fn().mockResolvedValue(undefined);
    const { ctrl } = makeController({ confirmMobileMoneyPayment });

    const result = await ctrl.handlePosPaymentWebhook(
      ORG_ID,
      makeReq(makeRaw({ type: 'payment.success', providerEventId: 'evt-no-sale' })) as never,
    );

    expect(result).toEqual({ received: true });
    expect(confirmMobileMoneyPayment).not.toHaveBeenCalled();
  });

  it('deuxième appel même providerEventId (P2002) : acquitté 200, confirmMobileMoneyPayment non rappelé', async () => {
    const confirmMobileMoneyPayment = jest.fn().mockResolvedValue(undefined);
    const { ctrl, webhookEvent } = makeController({ dupOnSecondCall: true, confirmMobileMoneyPayment });

    await ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD)) as never);
    const second = await ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD)) as never);

    expect(second).toEqual({ received: true });
    expect(webhookEvent.create).toHaveBeenCalledTimes(2);
    // Rejeu : idempotence garantie côté WebhookController, mais confirmMobileMoneyPayment() est
    // lui-même idempotent (PosService) — ici on vérifie juste que le doublon est acquitté sans erreur.
    expect(confirmMobileMoneyPayment).toHaveBeenCalledTimes(1);
  });

  it('signature invalide → 401 avant la garde d\'idempotence', async () => {
    const { ctrl, webhookEvent } = makeController({ signatureValid: false });

    await expect(
      ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD), 'bad') as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(webhookEvent.create).not.toHaveBeenCalled();
  });

  it('retourne 200 même si le type d\'événement est inconnu', async () => {
    const { ctrl } = makeController();

    const result = await ctrl.handlePosPaymentWebhook(
      ORG_ID,
      makeReq(makeRaw({ type: 'payment.refunded', providerEventId: 'evt-unknown' })) as never,
    );

    expect(result).toEqual({ received: true });
  });

  it('retourne 200 et n\'insère aucun WebhookEvent si l\'org est inconnue', async () => {
    const { ctrl, webhookEvent } = makeController({ orgExists: false });

    const result = await ctrl.handlePosPaymentWebhook(
      'ffffffff-0000-4000-f000-000000000001',
      makeReq(makeRaw(POS_PAYLOAD)) as never,
    );

    expect(result).toEqual({ received: true });
    expect(webhookEvent.create).not.toHaveBeenCalled();
  });

  it('rejette 401 si rawBody est absent', async () => {
    const { ctrl } = makeController();

    await expect(
      ctrl.handlePosPaymentWebhook(ORG_ID, { rawBody: undefined, headers: {} } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
