/**
 * Tests unitaires StorageService — S3 client entièrement mocké.
 * Vérifie que les commandes PutObject, GetObject (pré-signé) et DeleteObject
 * sont envoyées avec les bons paramètres.
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage.service';

// ─── Mocks S3 ────────────────────────────────────────────────────────────────

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((args) => ({ _name: 'PutObjectCommand', ...args })),
  GetObjectCommand: jest.fn().mockImplementation((args) => ({ _name: 'GetObjectCommand', ...args })),
  DeleteObjectCommand: jest.fn().mockImplementation((args) => ({ _name: 'DeleteObjectCommand', ...args })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BUCKET = 'ensemb-uploads';
const KEY = 'org-id/products/uuid.jpg';

function makeConfig(): Record<string, string> {
  return {
    S3_ENDPOINT:          'http://localhost:9000',
    S3_REGION:            'us-east-1',
    S3_BUCKET:            BUCKET,
    S3_ACCESS_KEY_ID:     'ensemb',
    S3_SECRET_ACCESS_KEY: 'ensemb_dev',
    S3_SIGNED_URL_TTL:    '3600',
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    mockSend.mockReset();
    mockGetSignedUrl.mockReset();

    const cfg = makeConfig();

    const module = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: (key: string) => cfg[key] },
        },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  // ── upload ────────────────────────────────────────────────────────────────

  describe('upload', () => {
    it('envoie PutObjectCommand avec la bonne clé, ContentType et buffer', async () => {
      mockSend.mockResolvedValue({});
      const buf = Buffer.from('fake-image');

      await service.upload(KEY, buf, 'image/jpeg');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const [cmd] = mockSend.mock.calls[0] as [{ Bucket: string; Key: string; ContentType: string; Body: Buffer }];
      expect(cmd.Bucket).toBe(BUCKET);
      expect(cmd.Key).toBe(KEY);
      expect(cmd.ContentType).toBe('image/jpeg');
      expect(cmd.Body).toBe(buf);
    });

    it('retourne la clé S3', async () => {
      mockSend.mockResolvedValue({});
      const result = await service.upload(KEY, Buffer.from('x'), 'image/png');
      expect(result).toBe(KEY);
    });
  });

  // ── getSignedUrl ──────────────────────────────────────────────────────────

  describe('getSignedUrl', () => {
    it('appelle le presigner avec le bon TTL par défaut (3600 s)', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed-url.example.com/obj');

      const url = await service.getSignedUrl(KEY);

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const [, , opts] = mockGetSignedUrl.mock.calls[0] as [unknown, unknown, { expiresIn: number }];
      expect(opts.expiresIn).toBe(3600);
      expect(url).toBe('https://signed-url.example.com/obj');
    });

    it('respecte le TTL personnalisé', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed-url.example.com/obj');

      await service.getSignedUrl(KEY, 900);

      const [, , opts] = mockGetSignedUrl.mock.calls[0] as [unknown, unknown, { expiresIn: number }];
      expect(opts.expiresIn).toBe(900);
    });
  });

  // ── delete ────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('envoie DeleteObjectCommand avec la bonne clé', async () => {
      mockSend.mockResolvedValue({});

      await service.delete(KEY);

      const [cmd] = mockSend.mock.calls[0] as [{ Bucket: string; Key: string }];
      expect(cmd.Bucket).toBe(BUCKET);
      expect(cmd.Key).toBe(KEY);
    });

    it('ne lève pas d\'erreur si S3 renvoie 204 (objet absent)', async () => {
      mockSend.mockResolvedValue({}); // S3/MinIO renvoie toujours 204 sur DELETE
      await expect(service.delete('inexistant/key.jpg')).resolves.toBeUndefined();
    });
  });
});
