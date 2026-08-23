import { createHmac } from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { TenantPaymentGatewayService } from '../tenant-payment-gateway.service';
import type { PaymentGatewayCredentialService } from '../payment-gateway-credential.service';

const ORG_A = 'aaaaaaaa-0000-4000-a000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-b000-000000000002';

const CREDENTIAL_A = {
  apiKey: 'sk_live_orgA_key',
  merchantId: 'MERCHANT-A',
  webhookSecret: 'secretOrgA',
};

const CREDENTIAL_B = {
  apiKey: 'sk_live_orgB_key',
  merchantId: 'MERCHANT-B',
  webhookSecret: 'secretOrgB',
};

/** Mock minimal de ConfigService — seule la méthode get() est utilisée par le service. */
const makeConfig = (values: Record<string, string> = {}) => ({
  get: jest.fn((key: string) => values[key]),
});

/** Mock minimal de PaymentGatewayCredentialService avec une résolution par organisation. */
const makeCredentialService = (
  byOrg: Record<string, { apiKey: string; merchantId: string | null; webhookSecret: string } | null>,
) => ({
  getDecryptedCredential: jest.fn((organizationId: string) =>
    Promise.resolve(byOrg[organizationId] ?? null),
  ),
});

describe('TenantPaymentGatewayService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('mode test (aucun credential actif)', () => {
    it('generatePaymentLink retourne un lien fictif https://pay.test/mock-* sans appel HTTP', async () => {
      const credentialService = makeCredentialService({});
      const config = makeConfig();
      const svc = new TenantPaymentGatewayService(
        credentialService as unknown as PaymentGatewayCredentialService,
        config as never,
      );
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as never;

      const link = await svc.generatePaymentLink(ORG_A, {
        amount: new Decimal('1500'),
        currency: 'XAF',
        reference: 'ref-1',
        callbackUrl: 'http://localhost/callback',
      });

      expect(link).toMatch(/^https:\/\/pay\.test\/mock-/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('verifyWebhookSignature retourne toujours true', async () => {
      const credentialService = makeCredentialService({});
      const config = makeConfig();
      const svc = new TenantPaymentGatewayService(
        credentialService as unknown as PaymentGatewayCredentialService,
        config as never,
      );

      const result = await svc.verifyWebhookSignature(
        ORG_A,
        Buffer.from('payload'),
        'n-importe-quoi',
      );

      expect(result).toBe(true);
    });
  });

  describe('résolution par organisation (credential actif)', () => {
    it('generatePaymentLink appelle getDecryptedCredential avec organizationId et effectue un POST avec le montant en string', async () => {
      const credentialService = makeCredentialService({ [ORG_A]: CREDENTIAL_A });
      const config = makeConfig({ PAYMENT_AGGREGATOR_BASE_URL: 'https://agg.test' });
      const svc = new TenantPaymentGatewayService(
        credentialService as unknown as PaymentGatewayCredentialService,
        config as never,
      );
      const fetchSpy = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ payment_url: 'https://agg.test/pay/xyz' }),
      });
      global.fetch = fetchSpy as never;

      const link = await svc.generatePaymentLink(ORG_A, {
        amount: new Decimal('2500.50'),
        currency: 'XAF',
        reference: 'ref-2',
        callbackUrl: 'http://localhost/callback',
      });

      expect(credentialService.getDecryptedCredential).toHaveBeenCalledWith(ORG_A);
      expect(link).toBe('https://agg.test/pay/xyz');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://agg.test/payment/init');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        `Bearer ${CREDENTIAL_A.apiKey}`,
      );
      const body = JSON.parse(init.body as string) as { amount: string };
      expect(body.amount).toBe('2500.5');
      expect(typeof body.amount).toBe('string');
    });

    it('generatePaymentLink lève une erreur explicite si l\'agrégateur répond en échec', async () => {
      const credentialService = makeCredentialService({ [ORG_A]: CREDENTIAL_A });
      const config = makeConfig();
      const svc = new TenantPaymentGatewayService(
        credentialService as unknown as PaymentGatewayCredentialService,
        config as never,
      );
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('bad request'),
      }) as never;

      await expect(
        svc.generatePaymentLink(ORG_A, {
          amount: new Decimal('100'),
          currency: 'XAF',
          reference: 'ref-3',
          callbackUrl: 'http://localhost/callback',
        }),
      ).rejects.toThrow();
    });

    it('verifyWebhookSignature retourne true pour une signature HMAC valide calculée avec le bon secret', async () => {
      const credentialService = makeCredentialService({ [ORG_A]: CREDENTIAL_A });
      const config = makeConfig();
      const svc = new TenantPaymentGatewayService(
        credentialService as unknown as PaymentGatewayCredentialService,
        config as never,
      );
      const payload = Buffer.from(JSON.stringify({ type: 'payment.success' }));
      const signature = createHmac('sha256', CREDENTIAL_A.webhookSecret).update(payload).digest('hex');

      const result = await svc.verifyWebhookSignature(ORG_A, payload, signature);

      expect(result).toBe(true);
    });

    it("isolation tenant : l'organisation A ne peut PAS valider une signature calculée avec le webhookSecret de l'organisation B", async () => {
      const credentialService = makeCredentialService({
        [ORG_A]: CREDENTIAL_A,
        [ORG_B]: CREDENTIAL_B,
      });
      const config = makeConfig();
      const svc = new TenantPaymentGatewayService(
        credentialService as unknown as PaymentGatewayCredentialService,
        config as never,
      );
      const payload = Buffer.from(JSON.stringify({ type: 'payment.success' }));
      // Signature calculée avec le secret de B...
      const signatureFromB = createHmac('sha256', CREDENTIAL_B.webhookSecret)
        .update(payload)
        .digest('hex');

      // ...vérifiée pour l'organisation A : doit échouer.
      const resultForA = await svc.verifyWebhookSignature(ORG_A, payload, signatureFromB);
      expect(resultForA).toBe(false);

      // Contrôle positif : la même signature est valide pour B (son propre secret).
      const resultForB = await svc.verifyWebhookSignature(ORG_B, payload, signatureFromB);
      expect(resultForB).toBe(true);
    });

    it('verifyWebhookSignature retourne false si la signature est invalide', async () => {
      const credentialService = makeCredentialService({ [ORG_A]: CREDENTIAL_A });
      const config = makeConfig();
      const svc = new TenantPaymentGatewayService(
        credentialService as unknown as PaymentGatewayCredentialService,
        config as never,
      );
      const payload = Buffer.from(JSON.stringify({ type: 'payment.success' }));

      const result = await svc.verifyWebhookSignature(ORG_A, payload, 'signature-invalide');

      expect(result).toBe(false);
    });
  });
});
