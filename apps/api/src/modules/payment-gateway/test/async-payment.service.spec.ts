import { Decimal } from '@prisma/client/runtime/library';
import { AsyncPaymentService } from '../async-payment.service';
import type { TenantPaymentGatewayService } from '../tenant-payment-gateway.service';
import type { PrismaService } from '../../../common/prisma.service';

const ORG_ID = 'aaaaaaaa-0000-4000-a000-000000000001';
const WEBHOOK_EVENT_ID = 'eeeeeeee-0000-4000-e000-000000000001';

/** Erreur imitant une violation de contrainte unique Prisma (P2002). */
class FakePrismaUniqueError extends Error {
  code = 'P2002';
}

const makeConfig = (values: Record<string, string> = {}) => ({
  get: jest.fn((key: string) => values[key]),
});

const makeGateway = (generatePaymentLinkResult = 'https://agg.test/pay/xyz') => ({
  generatePaymentLink: jest.fn().mockResolvedValue(generatePaymentLinkResult),
});

const makePrisma = () => ({
  webhookEvent: {
    create: jest.fn(),
    update: jest.fn(),
  },
});

describe('AsyncPaymentService', () => {
  describe('generatePaymentLinkFor', () => {
    it('construit callbackUrl à partir de POS_PAYMENT_CALLBACK_BASE_URL + callbackPath et délègue à TenantPaymentGatewayService', async () => {
      const gateway = makeGateway();
      const config = makeConfig({ POS_PAYMENT_CALLBACK_BASE_URL: 'https://api.ensemb.test/webhooks/payments' });
      const prisma = makePrisma();
      const svc = new AsyncPaymentService(
        gateway as unknown as TenantPaymentGatewayService,
        config as never,
        prisma as unknown as PrismaService,
      );

      const link = await svc.generatePaymentLinkFor(ORG_ID, {
        amount: new Decimal('1000'),
        currency: 'XAF',
        reference: 'sale-1',
        callbackPath: ORG_ID,
      });

      expect(link).toBe('https://agg.test/pay/xyz');
      expect(gateway.generatePaymentLink).toHaveBeenCalledWith(ORG_ID, {
        amount: new Decimal('1000'),
        currency: 'XAF',
        reference: 'sale-1',
        callbackUrl: `https://api.ensemb.test/webhooks/payments/${ORG_ID}`,
      });
    });

    it('retombe sur une base par défaut si POS_PAYMENT_CALLBACK_BASE_URL est absente', async () => {
      const gateway = makeGateway();
      const config = makeConfig();
      const prisma = makePrisma();
      const svc = new AsyncPaymentService(
        gateway as unknown as TenantPaymentGatewayService,
        config as never,
        prisma as unknown as PrismaService,
      );

      await svc.generatePaymentLinkFor(ORG_ID, {
        amount: new Decimal('1000'),
        currency: 'XAF',
        reference: 'sale-2',
        callbackPath: ORG_ID,
      });

      expect(gateway.generatePaymentLink).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({
          callbackUrl: `http://localhost:3000/api/v1/webhooks/payments/${ORG_ID}`,
        }),
      );
    });
  });

  describe('persistWebhookEvent', () => {
    it('retourne null sur doublon (P2002) sans lever', async () => {
      const gateway = makeGateway();
      const config = makeConfig();
      const prisma = makePrisma();
      prisma.webhookEvent.create.mockRejectedValue(new FakePrismaUniqueError('duplicate'));
      const svc = new AsyncPaymentService(
        gateway as unknown as TenantPaymentGatewayService,
        config as never,
        prisma as unknown as PrismaService,
      );

      const result = await svc.persistWebhookEvent({
        provider: 'pos-aggregator',
        providerEventId: 'evt-1',
        payload: { type: 'payment.success' },
        organizationId: ORG_ID,
        saleId: 'sale-1',
      });

      expect(result).toBeNull();
    });

    it('retourne null sur toute autre erreur DB sans lever', async () => {
      const gateway = makeGateway();
      const config = makeConfig();
      const prisma = makePrisma();
      prisma.webhookEvent.create.mockRejectedValue(new Error('connexion DB perdue'));
      const svc = new AsyncPaymentService(
        gateway as unknown as TenantPaymentGatewayService,
        config as never,
        prisma as unknown as PrismaService,
      );

      const result = await svc.persistWebhookEvent({
        provider: 'pos-aggregator',
        providerEventId: 'evt-2',
        payload: { type: 'payment.success' },
        organizationId: ORG_ID,
      });

      expect(result).toBeNull();
    });

    it("retourne l'id créé quand la persistance réussit", async () => {
      const gateway = makeGateway();
      const config = makeConfig();
      const prisma = makePrisma();
      prisma.webhookEvent.create.mockResolvedValue({ id: WEBHOOK_EVENT_ID });
      const svc = new AsyncPaymentService(
        gateway as unknown as TenantPaymentGatewayService,
        config as never,
        prisma as unknown as PrismaService,
      );

      const result = await svc.persistWebhookEvent({
        provider: 'pos-aggregator',
        providerEventId: 'evt-3',
        payload: { type: 'payment.success' },
        organizationId: ORG_ID,
        saleId: 'sale-3',
      });

      expect(result).toBe(WEBHOOK_EVENT_ID);
      expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
        data: {
          provider: 'pos-aggregator',
          providerEventId: 'evt-3',
          payload: { type: 'payment.success' },
          saleId: 'sale-3',
          onlinePaymentIntentId: null,
          organizationId: ORG_ID,
        },
        select: { id: true },
      });
    });
  });

  describe('markProcessed', () => {
    it("ne lève jamais même si l'update échoue", async () => {
      const gateway = makeGateway();
      const config = makeConfig();
      const prisma = makePrisma();
      prisma.webhookEvent.update.mockRejectedValue(new Error('DB indisponible'));
      const svc = new AsyncPaymentService(
        gateway as unknown as TenantPaymentGatewayService,
        config as never,
        prisma as unknown as PrismaService,
      );

      await expect(svc.markProcessed(WEBHOOK_EVENT_ID)).resolves.toBeUndefined();
    });

    it('appelle prisma.webhookEvent.update avec processedAt quand tout va bien', async () => {
      const gateway = makeGateway();
      const config = makeConfig();
      const prisma = makePrisma();
      prisma.webhookEvent.update.mockResolvedValue({ id: WEBHOOK_EVENT_ID });
      const svc = new AsyncPaymentService(
        gateway as unknown as TenantPaymentGatewayService,
        config as never,
        prisma as unknown as PrismaService,
      );

      await svc.markProcessed(WEBHOOK_EVENT_ID);

      expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
        where: { id: WEBHOOK_EVENT_ID },
        data: { processedAt: expect.any(Date) },
      });
    });
  });
});
