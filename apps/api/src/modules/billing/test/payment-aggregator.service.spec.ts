import { createHmac } from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { PaymentAggregatorService } from '../payment-aggregator.service';

const makeConfig = (overrides: Record<string, string | undefined> = {}) => ({
  get: jest.fn((key: string) => {
    const values: Record<string, string | undefined> = {
      NODE_ENV: 'test',
      PAYMENT_AGGREGATOR_API_KEY: undefined,
      PAYMENT_AGGREGATOR_SITE_ID: undefined,
      PAYMENT_AGGREGATOR_WEBHOOK_SECRET: undefined,
      ...overrides,
    };
    return values[key];
  }),
});

const makeServiceInTestMode = () => {
  const config = makeConfig({ NODE_ENV: 'test' });
  return new PaymentAggregatorService(config as never);
};

const makeServiceInProdMode = (secret: string) => {
  const config = makeConfig({
    NODE_ENV: 'production',
    PAYMENT_AGGREGATOR_API_KEY: 'api-key-123',
    PAYMENT_AGGREGATOR_SITE_ID: 'site-456',
    PAYMENT_AGGREGATOR_WEBHOOK_SECRET: secret,
  });
  return new PaymentAggregatorService(config as never);
};

describe('PaymentAggregatorService', () => {
  describe('generatePaymentLink', () => {
    it('en mode test : retourne un lien fictif sans appel HTTP réel', async () => {
      const service = makeServiceInTestMode();
      const url = await service.generatePaymentLink({
        amount: new Decimal('5000'),
        currency: 'XAF',
        reference: 'inv-001',
        callbackUrl: 'http://localhost:3000/api/v1/webhooks/billing',
      });

      expect(url).toMatch(/^https:\/\/pay\.test\/mock-/);
    });

    it('en mode test : chaque appel retourne un lien unique', async () => {
      const service = makeServiceInTestMode();
      const params = {
        amount: new Decimal('5000'),
        currency: 'XAF',
        reference: 'inv-001',
        callbackUrl: 'http://localhost:3000/api/v1/webhooks/billing',
      };

      const url1 = await service.generatePaymentLink(params);
      const url2 = await service.generatePaymentLink(params);

      expect(url1).not.toBe(url2);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('en mode test : toujours retourne true', () => {
      const service = makeServiceInTestMode();
      const result = service.verifyWebhookSignature(Buffer.from('payload'), 'invalid-sig');
      expect(result).toBe(true);
    });

    it('en mode prod : valide une signature HMAC-SHA256 correcte', () => {
      const secret = 'super-secret-webhook-key';
      const service = makeServiceInProdMode(secret);

      const payload = Buffer.from('{"type":"payment.success"}', 'utf8');
      const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');

      expect(service.verifyWebhookSignature(payload, expectedSig)).toBe(true);
    });

    it('en mode prod : rejette une signature invalide', () => {
      const secret = 'super-secret-webhook-key';
      const service = makeServiceInProdMode(secret);

      const payload = Buffer.from('{"type":"payment.success"}', 'utf8');

      expect(service.verifyWebhookSignature(payload, 'deadbeef')).toBe(false);
    });

    it('en mode prod : rejette une signature vide', () => {
      const secret = 'super-secret-webhook-key';
      const service = makeServiceInProdMode(secret);

      const payload = Buffer.from('{"type":"payment.success"}', 'utf8');

      expect(service.verifyWebhookSignature(payload, '')).toBe(false);
    });

    it('en mode prod : rejette si le payload est altéré', () => {
      const secret = 'super-secret-webhook-key';
      const service = makeServiceInProdMode(secret);

      const original = Buffer.from('{"type":"payment.success"}', 'utf8');
      const validSig = createHmac('sha256', secret).update(original).digest('hex');

      const tampered = Buffer.from('{"type":"payment.fail"}', 'utf8');
      expect(service.verifyWebhookSignature(tampered, validSig)).toBe(false);
    });
  });
});
