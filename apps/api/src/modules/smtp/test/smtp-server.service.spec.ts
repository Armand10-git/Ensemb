import { NotFoundException } from '@nestjs/common';
import { SmtpServerService } from '../smtp-server.service';
import { EncryptionService } from '../../../common/encryption.service';

const ORG_ID = 'aaaaaaaa-0000-4000-a000-000000000001';
const SMTP_ID = 'bbbbbbbb-0000-4000-b000-000000000001';

const DTO = {
  host: 'smtp.example.com',
  port: 587,
  username: 'user@example.com',
  password: 'MonMotDePasse123!',
  fromEmail: 'noreply@example.com',
  fromName: 'Ensemb',
};

const PUBLIC_RECORD = {
  id: SMTP_ID,
  organizationId: ORG_ID,
  host: DTO.host,
  port: DTO.port,
  username: DTO.username,
  fromEmail: DTO.fromEmail,
  fromName: DTO.fromName,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// EncryptionService réel (sans ConfigService) instancié directement pour les tests
const makeEncryption = () => {
  const enc = new EncryptionService({ getOrThrow: () => 'test-key-32-chars-padding!!!!!' } as never);
  enc.onModuleInit();
  return enc;
};

const makePrisma = (upsertResult = PUBLIC_RECORD, findResult: { passwordCipher: string } | null = null) => ({
  smtpServer: {
    upsert: jest.fn().mockResolvedValue(upsertResult),
    findUnique: jest.fn().mockResolvedValue(findResult),
  },
});

const makeService = (opts: {
  upsertResult?: typeof PUBLIC_RECORD;
  findResult?: { passwordCipher: string } | null;
} = {}) => {
  const enc = makeEncryption();
  const prisma = makePrisma(opts.upsertResult ?? PUBLIC_RECORD, opts.findResult ?? null);
  const svc = new SmtpServerService(prisma as never, enc);
  return { svc, prisma, enc };
};

describe('SmtpServerService', () => {
  describe('upsert', () => {
    it('stocke un chiffré (pas le plaintext) en base', async () => {
      const { svc, prisma, enc } = makeService();

      await svc.upsert(ORG_ID, DTO);

      const createCall = (prisma.smtpServer.upsert as jest.Mock).mock.calls[0][0];
      const storedCipher: string = createCall.create.passwordCipher;
      // La valeur persistée ne doit pas contenir le mot de passe en clair
      expect(storedCipher).not.toContain(DTO.password);
      // Elle doit correspondre au format iv:authTag:ciphertext (hex)
      expect(storedCipher.split(':')).toHaveLength(3);
      // Déchiffrement retrouve le plaintext
      expect(enc.decrypt(storedCipher)).toBe(DTO.password);
    });

    it('retourne un objet sans passwordCipher ni password', async () => {
      const { svc } = makeService();

      const result = await svc.upsert(ORG_ID, DTO);

      expect(result).not.toHaveProperty('passwordCipher');
      expect(result).not.toHaveProperty('password');
      expect(result).toMatchObject({
        id: SMTP_ID,
        organizationId: ORG_ID,
        host: DTO.host,
      });
    });

    it('deux upsert successifs appellent prisma.smtpServer.upsert deux fois (idempotent)', async () => {
      const { svc, prisma } = makeService();

      await svc.upsert(ORG_ID, DTO);
      await svc.upsert(ORG_ID, { ...DTO, password: 'NouveauMDP!' });

      expect(prisma.smtpServer.upsert).toHaveBeenCalledTimes(2);
    });

    it('le chiffré stocké change entre deux upserts (IV aléatoire)', async () => {
      const { svc, prisma } = makeService();

      await svc.upsert(ORG_ID, DTO);
      await svc.upsert(ORG_ID, DTO); // même mot de passe

      const [call1, call2] = (prisma.smtpServer.upsert as jest.Mock).mock.calls;
      const cipher1: string = call1[0].create.passwordCipher;
      const cipher2: string = call2[0].create.passwordCipher;
      expect(cipher1).not.toBe(cipher2);
    });
  });

  describe('getDecryptedPassword', () => {
    it('retrouve le bon plaintext après upsert (round-trip via EncryptionService)', async () => {
      const enc = makeEncryption();
      const cipher = enc.encrypt(DTO.password);
      const prisma = makePrisma(PUBLIC_RECORD, { passwordCipher: cipher });
      const svc = new SmtpServerService(prisma as never, enc);

      const result = await svc.getDecryptedPassword(ORG_ID);

      expect(result).toBe(DTO.password);
    });

    it('lève NotFoundException si aucune config SMTP pour l\'org', async () => {
      const enc = makeEncryption();
      const prisma = makePrisma(PUBLIC_RECORD, null);
      const svc = new SmtpServerService(prisma as never, enc);

      await expect(svc.getDecryptedPassword(ORG_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
