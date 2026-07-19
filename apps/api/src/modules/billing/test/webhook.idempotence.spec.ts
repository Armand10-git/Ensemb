import { UnauthorizedException } from '@nestjs/common';
import { WebhookController } from '../webhook.controller';

const ORG_ID   = 'aaaaaaaa-0000-4000-a000-000000000001';
const INV_ID   = 'aaaaaaaa-0000-4000-a000-000000000004';
const PROV_ID  = 'evt-idempotence-xyz';

const BILLING_PAYLOAD = {
  type: 'payment.success',
  provider: 'test-aggregator',
  providerEventId: PROV_ID,
  invoiceId: INV_ID,
};

const POS_PAYLOAD = {
  type: 'payment.success',
  providerEventId: PROV_ID,
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
  confirmPayment?: jest.Mock;
  dupOnSecondCall?: boolean;
  orgExists?: boolean;
} = {}) => {
  const aggregator = { verifyWebhookSignature: jest.fn().mockReturnValue(opts.signatureValid ?? true) };
  const confirmPayment = opts.confirmPayment ?? jest.fn().mockResolvedValue(undefined);
  const billing = { confirmPayment };
  const webhookEvent = makeWebhookEvent(opts.dupOnSecondCall ?? false);
  const prisma = {
    webhookEvent,
    invoice: { findUnique: jest.fn().mockResolvedValue({ organizationId: ORG_ID }) },
    organization: {
      findUnique: jest.fn().mockResolvedValue(
        (opts.orgExists ?? true) ? { id: ORG_ID } : null,
      ),
    },
  };
  const ctrl = new WebhookController(aggregator as never, billing as never, prisma as never);
  return { ctrl, aggregator, billing, prisma, webhookEvent, confirmPayment };
};

describe('WebhookController — idempotence', () => {
  describe('handleBillingWebhook', () => {
    it('premier appel : WebhookEvent créé + confirmPayment appelé', async () => {
      const { ctrl, webhookEvent, confirmPayment } = makeController();

      await ctrl.handleBillingWebhook(makeReq(makeRaw(BILLING_PAYLOAD)) as never);

      expect(webhookEvent.create).toHaveBeenCalledTimes(1);
      expect(confirmPayment).toHaveBeenCalledWith(INV_ID);
    });

    it('deuxième appel même providerEventId (P2002) : acquitté 200, confirmPayment non rappelé', async () => {
      const confirmPayment = jest.fn().mockResolvedValue(undefined);
      const { ctrl, webhookEvent } = makeController({ confirmPayment, dupOnSecondCall: true });

      await ctrl.handleBillingWebhook(makeReq(makeRaw(BILLING_PAYLOAD)) as never);
      const secondResult = await ctrl.handleBillingWebhook(makeReq(makeRaw(BILLING_PAYLOAD)) as never);

      expect(secondResult).toEqual({ received: true });
      // confirmPayment appelé une seule fois (premier appel)
      expect(confirmPayment).toHaveBeenCalledTimes(1);
      // create appelé deux fois — la deuxième lance P2002
      expect(webhookEvent.create).toHaveBeenCalledTimes(2);
    });

    it('signature invalide → 401 avant la garde d\'idempotence', async () => {
      const { ctrl, webhookEvent } = makeController({ signatureValid: false });

      await expect(
        ctrl.handleBillingWebhook(makeReq(makeRaw(BILLING_PAYLOAD), 'bad') as never)
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(webhookEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('handlePosPaymentWebhook', () => {
    it('premier appel : WebhookEvent créé (provider = "pos-aggregator")', async () => {
      const { ctrl, webhookEvent } = makeController();

      const result = await ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD)) as never);

      expect(result).toEqual({ received: true });
      expect(webhookEvent.create).toHaveBeenCalledTimes(1);
      expect((webhookEvent.create as jest.Mock).mock.calls[0][0].data.provider).toBe('pos-aggregator');
      expect((webhookEvent.create as jest.Mock).mock.calls[0][0].data.organizationId).toBe(ORG_ID);
    });

    it('deuxième appel même providerEventId (P2002) : acquitté 200, stub non rappelé', async () => {
      const { ctrl, webhookEvent } = makeController({ dupOnSecondCall: true });

      await ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD)) as never);
      const second = await ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD)) as never);

      expect(second).toEqual({ received: true });
      expect(webhookEvent.create).toHaveBeenCalledTimes(2);
    });

    it('signature invalide → 401 avant la garde d\'idempotence', async () => {
      const { ctrl, webhookEvent } = makeController({ signatureValid: false });

      await expect(
        ctrl.handlePosPaymentWebhook(ORG_ID, makeReq(makeRaw(POS_PAYLOAD), 'bad') as never)
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
  });
});
