/**
 * Tests unitaires UploadsService.
 * StorageService est mocké — aucun appel S3 réel.
 * Couvre : rejet par magic bytes, re-encodage sharp, sécurité (EXE renommé .jpg),
 *          dépassement de taille, clé S3 correcte, suppression.
 */

import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import { UploadsService } from '../uploads.service';
import { StorageService } from '../storage.service';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001';

/** Construit un buffer JPEG minimal valide (magic bytes FF D8 FF). */
async function makeJpegBuffer(width = 10, height = 10): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .jpeg()
    .toBuffer();
}

/** Construit un buffer PNG minimal valide (magic bytes 89 50 4E 47). */
async function makePngBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } } })
    .png()
    .toBuffer();
}

/** Construit un buffer WebP minimal valide. */
async function makeWebpBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .webp()
    .toBuffer();
}

/** Buffer PDF minimal (magic bytes 25 50 44 46 = %PDF). */
function makePdfBuffer(): Buffer {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
}

/** Buffer EXE minimal (magic bytes 4D 5A = MZ). */
function makeExeBuffer(): Buffer {
  return Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
}

/** Buffer GIF minimal (magic bytes 47 49 46 38 = GIF8). */
function makeGifBuffer(): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
}

function makeMulterFile(buffer: Buffer, originalname = 'test.jpg'): Express.Multer.File {
  return {
    buffer,
    size: buffer.length,
    originalname,
    fieldname: 'file',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    destination: '',
    filename: '',
    path: '',
    stream: null as unknown as Express.Multer.File['stream'],
  };
}

// ─── Mock StorageService ──────────────────────────────────────────────────────

const storageMock = {
  upload:       jest.fn(),
  getSignedUrl: jest.fn(),
  delete:       jest.fn(),
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('UploadsService', () => {
  let service: UploadsService;

  beforeEach(async () => {
    storageMock.upload.mockReset();
    storageMock.getSignedUrl.mockReset();
    storageMock.delete.mockReset();

    storageMock.upload.mockImplementation((key: string) => Promise.resolve(key));
    storageMock.getSignedUrl.mockResolvedValue('https://signed.example.com/obj');
    storageMock.delete.mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        UploadsService,
        { provide: StorageService, useValue: storageMock },
      ],
    }).compile();

    service = module.get(UploadsService);
  });

  // ── uploadImage — formats valides ─────────────────────────────────────────

  describe('uploadImage — formats valides', () => {
    it('JPEG valide → clé S3 au format <orgId>/products/<uuid>.jpg', async () => {
      const buffer = await makeJpegBuffer();
      const file = makeMulterFile(buffer, 'photo.jpg');

      const key = await service.uploadImage(ORG_ID, 'products', file);

      expect(key).toMatch(new RegExp(`^${ORG_ID}/products/[a-f0-9-]+\\.jpg$`));
      expect(storageMock.upload).toHaveBeenCalledTimes(1);
      const [calledKey, , mime] = storageMock.upload.mock.calls[0] as [string, Buffer, string];
      expect(calledKey).toBe(key);
      expect(mime).toBe('image/jpeg');
    });

    it('PNG valide → re-encodé en PNG, clé correcte', async () => {
      const buffer = await makePngBuffer();
      const file = makeMulterFile(buffer, 'logo.png');

      const key = await service.uploadImage(ORG_ID, 'brands', file);

      expect(key).toMatch(/\.png$/);
      const [, , mime] = storageMock.upload.mock.calls[0] as [string, Buffer, string];
      expect(mime).toBe('image/png');
    });

    it('WebP valide → re-encodé en WebP, clé correcte', async () => {
      const buffer = await makeWebpBuffer();
      const file = makeMulterFile(buffer, 'avatar.webp');

      const key = await service.uploadImage(ORG_ID, 'avatars', file);

      expect(key).toMatch(/\.webp$/);
      const [, , mime] = storageMock.upload.mock.calls[0] as [string, Buffer, string];
      expect(mime).toBe('image/webp');
    });
  });

  // ── uploadImage — rejets par magic bytes ─────────────────────────────────

  describe('uploadImage — rejets par magic bytes', () => {
    it('PDF (25 50 44 46) → UnsupportedMediaTypeException', async () => {
      const file = makeMulterFile(makePdfBuffer(), 'document.pdf');
      await expect(service.uploadImage(ORG_ID, 'products', file))
        .rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('GIF (47 49 46 38) → UnsupportedMediaTypeException', async () => {
      const file = makeMulterFile(makeGifBuffer(), 'anim.gif');
      await expect(service.uploadImage(ORG_ID, 'products', file))
        .rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('EXE renommé .jpg (magic bytes MZ) → UnsupportedMediaTypeException (test sécurité)', async () => {
      const file = makeMulterFile(makeExeBuffer(), 'photo.jpg');
      await expect(service.uploadImage(ORG_ID, 'products', file))
        .rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('JPEG renommé .exe → détecté comme JPEG (magic bytes, pas l\'extension)', async () => {
      const buffer = await makeJpegBuffer();
      const file = makeMulterFile(buffer, 'payload.exe'); // extension trompeuse

      const key = await service.uploadImage(ORG_ID, 'products', file);

      // Détection par magic bytes → accepté comme JPEG malgré l'extension .exe
      expect(key).toMatch(/\.jpg$/);
    });
  });

  // ── uploadImage — dépassement de taille ─────────────────────────────────

  describe('uploadImage — dépassement de taille', () => {
    it('fichier > 5 Mo → PayloadTooLargeException', async () => {
      const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0xff);
      const file = makeMulterFile(big, 'huge.jpg');
      // file.size est calculé depuis buffer.length dans makeMulterFile

      await expect(service.uploadImage(ORG_ID, 'products', file))
        .rejects.toBeInstanceOf(PayloadTooLargeException);
    });
  });

  // ── uploadImage — strip des métadonnées EXIF ─────────────────────────────

  describe('uploadImage — sécurité re-encodage', () => {
    it('les métadonnées EXIF ne sont pas présentes dans l\'image re-encodée', async () => {
      // Génère un JPEG avec métadonnées EXIF simulées (sharp les injecte)
      const withExif = await sharp({
        create: { width: 10, height: 10, channels: 3, background: '#ff0000' },
      })
        .withMetadata({ exif: { IFD0: { Copyright: 'Payload EXIF' } } })
        .jpeg()
        .toBuffer();

      const file = makeMulterFile(withExif, 'photo.jpg');

      await service.uploadImage(ORG_ID, 'products', file);

      // Récupère le buffer re-encodé transmis à StorageService
      const [, reencoded] = storageMock.upload.mock.calls[0] as [string, Buffer];

      // Vérifie que les métadonnées EXIF ont été supprimées
      const meta = await sharp(reencoded).metadata();
      expect(meta.exif).toBeUndefined();
    });
  });

  // ── getSignedUrl ──────────────────────────────────────────────────────────

  describe('getSignedUrl', () => {
    it('délègue à StorageService.getSignedUrl avec la bonne clé', async () => {
      const key = `${ORG_ID}/products/uuid.jpg`;
      const url = await service.getSignedUrl(key);

      expect(storageMock.getSignedUrl).toHaveBeenCalledWith(key);
      expect(url).toBe('https://signed.example.com/obj');
    });
  });

  // ── deleteImage ───────────────────────────────────────────────────────────

  describe('deleteImage', () => {
    it('appelle StorageService.delete avec la bonne clé', async () => {
      const key = `${ORG_ID}/logos/uuid.png`;
      await service.deleteImage(key);

      expect(storageMock.delete).toHaveBeenCalledWith(key);
    });
  });
});
