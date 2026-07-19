import { UnauthorizedException } from '@nestjs/common';
import { WebhookController } from '../webhook.controller';

const INV_ID   = 'aaaaaaaa-0000-4000-a000-000000000004';
const PROV_ID  = 'evt-provider-abc123';

const VALID_PAYLOAD = {
  type: 'payment.success',
  provider: 'test-aggregator',
  providerEventId: PROV_ID,
  invoiceId: INV_ID,
};

const makeRawBody = (obj: object) => Buffer.from(JSON.stringify(obj), 'utf8');

const makeRequest = (rawBody: Buffer, signature = 'valid-sig') => ({
  rawBody,
  headers: { 'x-aggregator-signature': signature },
});

const makeAggregator = (signatureValid = true) => ({
  verifyWebhookSignature: jest.fn().mockReturnValue(signatureValid),
});

const makeConfirmPayment = () => jest.fn().mockResolvedValue(undefined);

const makeBillingService = (overrides: { confirmPayment?: jest.Mock } = {}) => ({
  confirmPayment: overrides.confirmPayment ?? makeConfirmPayment(),
});

// P2002 = violation de contrainte unique Prisma
const P2002 = Object.assign(new Error('Unique constraint'), { code: 'P2002' });

const makeWebhookEvent = () => ({
  create: jest.fn().mockResolvedValue({ id: 'evt-uuid-mock' }),
  update: jest.fn().mockResolvedValue({}),
});

const makeInvoice = () => ({
  findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-uuid-mock' }),
});

const makePrisma = (
  webhookEvent = makeWebhookEvent(),
  invoice = makeInvoice(),
) => ({
  webhookEvent,
  invoice,
});

const makeController = (opts: {
  signatureValid?: boolean;
  confirmPayment?: jest.Mock;
  prismaWebhookEvent?: ReturnType<typeof makeWebhookEvent>;
  prismaInvoice?: ReturnType<typeof makeInvoice>;
} = {}) => {
  const aggregator = makeAggregator(opts.signatureValid ?? true);
  const billing = makeBillingService({ confirmPayment: opts.confirmPayment });
  const prisma = makePrisma(
    opts.prismaWebhookEvent ?? makeWebhookEvent(),
    opts.prismaInvoice ?? makeInvoice(),
  );
  const controller = new WebhookController(
    aggregator as never,
    billing as never,
    prisma as never,
  );
  return { controller, aggregator, billing, prisma };
};

describe('WebhookController', () => {
  describe('handleBillingWebhook', () => {
    it('retourne 200 { received: true } sur un événement payment.success valide', async () => {
      const { controller } = makeController();
      const req = makeRequest(makeRawBody(VALID_PAYLOAD));

      const result = await controller.handleBillingWebhook(req as never);

      expect(result).toEqual({ received: true });
    });

    it('appelle confirmPayment avec l\'invoiceId sur un payment.success valide', async () => {
      const confirmPayment = makeConfirmPayment();
      const { controller } = makeController({ confirmPayment });
      const req = makeRequest(makeRawBody(VALID_PAYLOAD));

      await controller.handleBillingWebhook(req as never);

      expect(confirmPayment).toHaveBeenCalledWith(INV_ID);
    });

    it('rejette 401 si la signature HMAC est invalide', async () => {
      const { controller } = makeController({ signatureValid: false });
      const req = makeRequest(makeRawBody(VALID_PAYLOAD), 'bad-sig');

      await expect(controller.handleBillingWebhook(req as never)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('ne traite pas la base si la signature est invalide', async () => {
      const confirmPayment = makeConfirmPayment();
      const { controller, prisma } = makeController({ signatureValid: false, confirmPayment });
      const req = makeRequest(makeRawBody(VALID_PAYLOAD), 'bad-sig');

      await controller.handleBillingWebhook(req as never).catch(() => undefined);

      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
      expect(confirmPayment).not.toHaveBeenCalled();
    });

    it('retourne 200 immédiatement si l\'événement est rejoué (P2002)', async () => {
      const confirmPayment = makeConfirmPayment();
      const prismaWebhookEvent = {
        create: jest.fn().mockRejectedValue(P2002),
        update: jest.fn().mockResolvedValue({}),
      };
      const { controller } = makeController({ confirmPayment, prismaWebhookEvent });
      const req = makeRequest(makeRawBody(VALID_PAYLOAD));

      const result = await controller.handleBillingWebhook(req as never);

      expect(result).toEqual({ received: true });
      // confirmPayment ne doit pas être appelé sur un rejeu
      expect(confirmPayment).not.toHaveBeenCalled();
    });

    it('retourne 200 même si confirmPayment lève une erreur interne', async () => {
      const confirmPayment = jest.fn().mockRejectedValue(new Error('DB down'));
      const { controller } = makeController({ confirmPayment });
      const req = makeRequest(makeRawBody(VALID_PAYLOAD));

      const result = await controller.handleBillingWebhook(req as never);

      // Ne doit pas relancer l'exception — 200 pour éviter les retries de l'agrégateur
      expect(result).toEqual({ received: true });
    });

    it('retourne 200 si le body est du JSON invalide (après vérification HMAC)', async () => {
      const { controller } = makeController();
      const req = makeRequest(Buffer.from('not-json', 'utf8'));

      const result = await controller.handleBillingWebhook(req as never);

      expect(result).toEqual({ received: true });
    });

    it('rejette 401 si rawBody est absent', async () => {
      const { controller } = makeController();
      const req = { rawBody: undefined, headers: {} };

      await expect(controller.handleBillingWebhook(req as never)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('ignore un événement d\'un type inconnu sans appeler confirmPayment', async () => {
      const confirmPayment = makeConfirmPayment();
      const { controller } = makeController({ confirmPayment });
      const req = makeRequest(makeRawBody({
        type: 'payment.refunded',
        provider: 'test-aggregator',
        providerEventId: 'evt-other',
        invoiceId: INV_ID,
      }));

      const result = await controller.handleBillingWebhook(req as never);

      expect(result).toEqual({ received: true });
      expect(confirmPayment).not.toHaveBeenCalled();
    });

    it('retourne 200 et persiste le WebhookEvent avant confirmPayment', async () => {
      const callOrder: string[] = [];
      const prismaWebhookEvent = {
        create: jest.fn().mockImplementation(async () => {
          callOrder.push('webhookEvent.create');
          return { id: 'evt-uuid-mock' }; // le contrôleur utilise evt.id pour processedAt
        }),
        update: jest.fn().mockResolvedValue({}), // update processedAt (fire-and-forget)
      };
      const confirmPayment = jest.fn().mockImplementation(async () => {
        callOrder.push('confirmPayment');
      });
      const { controller } = makeController({ confirmPayment, prismaWebhookEvent });
      const req = makeRequest(makeRawBody(VALID_PAYLOAD));

      await controller.handleBillingWebhook(req as never);

      expect(callOrder).toEqual(['webhookEvent.create', 'confirmPayment']);
    });
  });
});
