import { PaymentGatewayCredentialService } from '../payment-gateway-credential.service';
import { EncryptionService } from '../../../common/encryption.service';

const ORG_ID = 'aaaaaaaa-0000-4000-a000-000000000001';
const CREDENTIAL_ID = 'cccccccc-0000-4000-c000-000000000001';

const DTO = {
  apiKey: 'sk_live_MonApiKeyDeTest123!',
  merchantId: 'MERCHANT-001',
  webhookSecret: 'MonWebhookSecret456!',
  isActive: true,
};

const PUBLIC_RECORD = {
  id: CREDENTIAL_ID,
  organizationId: ORG_ID,
  merchantId: DTO.merchantId,
  isActive: DTO.isActive,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// EncryptionService réel (sans ConfigService) instancié directement pour les tests
const makeEncryption = () => {
  const enc = new EncryptionService({ getOrThrow: () => 'test-key-32-chars-padding!!!!!' } as never);
  enc.onModuleInit();
  return enc;
};

const makePrisma = (
  upsertResult = PUBLIC_RECORD,
  findResult:
    | { apiKeyCipher: string; merchantId: string | null; webhookSecretCipher: string; isActive: boolean }
    | null = null,
) => ({
  paymentGatewayCredential: {
    upsert: jest.fn().mockResolvedValue(upsertResult),
    findUnique: jest.fn().mockResolvedValue(findResult),
  },
});

const makeService = (
  opts: {
    upsertResult?: typeof PUBLIC_RECORD;
    findResult?: {
      apiKeyCipher: string;
      merchantId: string | null;
      webhookSecretCipher: string;
      isActive: boolean;
    } | null;
  } = {},
) => {
  const enc = makeEncryption();
  const prisma = makePrisma(opts.upsertResult ?? PUBLIC_RECORD, opts.findResult ?? null);
  const svc = new PaymentGatewayCredentialService(prisma as never, enc);
  return { svc, prisma, enc };
};

describe('PaymentGatewayCredentialService', () => {
  describe('upsert', () => {
    it('stocke des valeurs chiffrées (pas le plaintext) en base', async () => {
      const { svc, prisma, enc } = makeService();

      await svc.upsert(ORG_ID, DTO);

      const createCall = (prisma.paymentGatewayCredential.upsert as jest.Mock).mock.calls[0][0];
      const storedApiKeyCipher: string = createCall.create.apiKeyCipher;
      const storedWebhookSecretCipher: string = createCall.create.webhookSecretCipher;
      // Les valeurs persistées ne doivent pas contenir les secrets en clair
      expect(storedApiKeyCipher).not.toContain(DTO.apiKey);
      expect(storedWebhookSecretCipher).not.toContain(DTO.webhookSecret);
      // Elles doivent correspondre au format iv:authTag:ciphertext (hex)
      expect(storedApiKeyCipher.split(':')).toHaveLength(3);
      expect(storedWebhookSecretCipher.split(':')).toHaveLength(3);
      // Déchiffrement retrouve le plaintext
      expect(enc.decrypt(storedApiKeyCipher)).toBe(DTO.apiKey);
      expect(enc.decrypt(storedWebhookSecretCipher)).toBe(DTO.webhookSecret);
    });

    it('retourne un objet sans apiKeyCipher, webhookSecretCipher, apiKey ni webhookSecret', async () => {
      const { svc } = makeService();

      const result = await svc.upsert(ORG_ID, DTO);

      expect(result).not.toHaveProperty('apiKeyCipher');
      expect(result).not.toHaveProperty('webhookSecretCipher');
      expect(result).not.toHaveProperty('apiKey');
      expect(result).not.toHaveProperty('webhookSecret');
      expect(result).toMatchObject({
        id: CREDENTIAL_ID,
        organizationId: ORG_ID,
        merchantId: DTO.merchantId,
      });
    });

    it('deux upsert successifs appellent prisma.paymentGatewayCredential.upsert deux fois (idempotent)', async () => {
      const { svc, prisma } = makeService();

      await svc.upsert(ORG_ID, DTO);
      await svc.upsert(ORG_ID, { ...DTO, apiKey: 'sk_live_NouvelleCle!' });

      expect(prisma.paymentGatewayCredential.upsert).toHaveBeenCalledTimes(2);
    });

    it('les chiffrés stockés changent entre deux upserts (IV aléatoire)', async () => {
      const { svc, prisma } = makeService();

      await svc.upsert(ORG_ID, DTO); // mêmes secrets
      await svc.upsert(ORG_ID, DTO);

      const [call1, call2] = (prisma.paymentGatewayCredential.upsert as jest.Mock).mock.calls;
      const cipher1: string = call1[0].create.apiKeyCipher;
      const cipher2: string = call2[0].create.apiKeyCipher;
      expect(cipher1).not.toBe(cipher2);
    });
  });

  describe('findForOrg', () => {
    it('ne lève jamais et retourne null si aucune configuration', async () => {
      const { svc } = makeService();

      const result = await svc.findForOrg(ORG_ID);

      expect(result).toBeNull();
    });
  });

  describe('getDecryptedCredential', () => {
    it('retrouve les bons secrets en clair après upsert (round-trip via EncryptionService)', async () => {
      const enc = makeEncryption();
      const apiKeyCipher = enc.encrypt(DTO.apiKey);
      const webhookSecretCipher = enc.encrypt(DTO.webhookSecret);
      const prisma = makePrisma(PUBLIC_RECORD, {
        apiKeyCipher,
        merchantId: DTO.merchantId,
        webhookSecretCipher,
        isActive: true,
      });
      const svc = new PaymentGatewayCredentialService(prisma as never, enc);

      const result = await svc.getDecryptedCredential(ORG_ID);

      expect(result).toEqual({
        apiKey: DTO.apiKey,
        merchantId: DTO.merchantId,
        webhookSecret: DTO.webhookSecret,
      });
    });

    it('retourne null (sans lever) si aucune configuration pour l\'organisation', async () => {
      const enc = makeEncryption();
      const prisma = makePrisma(PUBLIC_RECORD, null);
      const svc = new PaymentGatewayCredentialService(prisma as never, enc);

      const result = await svc.getDecryptedCredential(ORG_ID);

      expect(result).toBeNull();
    });

    it('retourne null (sans lever) si la configuration existe mais isActive=false', async () => {
      const enc = makeEncryption();
      const apiKeyCipher = enc.encrypt(DTO.apiKey);
      const webhookSecretCipher = enc.encrypt(DTO.webhookSecret);
      const prisma = makePrisma(PUBLIC_RECORD, {
        apiKeyCipher,
        merchantId: DTO.merchantId,
        webhookSecretCipher,
        isActive: false,
      });
      const svc = new PaymentGatewayCredentialService(prisma as never, enc);

      const result = await svc.getDecryptedCredential(ORG_ID);

      expect(result).toBeNull();
    });
  });
});
