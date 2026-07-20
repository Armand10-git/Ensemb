import { Injectable, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { fromBuffer } from 'file-type';
import { StorageService } from './storage.service';

const MAX_BYTES = 5 * 1024 * 1024; // 5 Mo
const MAX_DIM = 2000;

type ImageType = 'products' | 'brands' | 'logos' | 'avatars';

/** Instance retournée par sharp() — évite l'usage du namespace sharp.Sharp non résolu en CJS */
type SharpPipeline = ReturnType<typeof sharp>;

/** MIME → extension de fichier et paramètres sharp */
const TYPE_MAP = {
  'image/jpeg': { ext: 'jpg', encode: (s: SharpPipeline) => s.jpeg({ quality: 85, progressive: true }) },
  'image/png':  { ext: 'png', encode: (s: SharpPipeline) => s.png({ compressionLevel: 9 }) },
  'image/webp': { ext: 'webp', encode: (s: SharpPipeline) => s.webp({ quality: 85 }) },
} as const;

type AllowedMime = keyof typeof TYPE_MAP;

/**
 * Orchestration upload : magic bytes → re-encodage sharp → upload S3.
 * La clé S3 (jamais l'URL signée) est ce que les autres services persistront en base.
 */
@Injectable()
export class UploadsService {
  constructor(private readonly storage: StorageService) {}

  /**
   * Pipeline complet : magic bytes → re-encodage sharp → upload S3.
   * @param organizationId - préfixe S3 pour l'isolation tenant
   * @param type - "products" | "brands" | "logos" | "avatars"
   * @param file - buffer brut reçu de multer (memoryStorage)
   * @returns clé S3 persistée en base (jamais l'URL signée — celle-ci est éphémère)
   */
  async uploadImage(
    organizationId: string,
    type: ImageType,
    file: Express.Multer.File,
  ): Promise<string> {
    // 1. Vérification de taille en premier — avant tout décodage
    if (file.size > MAX_BYTES) {
      throw new PayloadTooLargeException('Image trop volumineuse — maximum 5 Mo');
    }

    // 2. Détection du type réel via magic bytes (file-type v16 CJS)
    const detected = await fromBuffer(file.buffer);

    if (!detected || !(detected.mime in TYPE_MAP)) {
      throw new UnsupportedMediaTypeException(
        'Format non supporté — JPEG, PNG ou WebP uniquement',
      );
    }

    const mime = detected.mime as AllowedMime;
    const { ext, encode } = TYPE_MAP[mime];

    // 3. Re-encodage via sharp
    //    - redimensionnement si > 2000 px sur le plus grand côté
    //    - strip des métadonnées EXIF (withMetadata non appelé = supprimé)
    //    - neutralise les payloads malveillants embarqués
    const pipeline = sharp(file.buffer).resize(MAX_DIM, MAX_DIM, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    const reencoded = await encode(pipeline).toBuffer();

    // 4. Clé S3 : <organizationId>/<type>/<uuid>.<ext>
    const key = `${organizationId}/${type}/${randomUUID()}.${ext}`;

    // 5. Upload vers S3/MinIO
    await this.storage.upload(key, reencoded, mime);

    return key;
  }

  /**
   * Retourne une URL signée à partir d'une clé S3 stockée en base.
   * Appeler à chaque lecture — ne jamais persister l'URL signée (éphémère).
   * @param s3Key - clé S3 telle que retournée par uploadImage
   */
  async getSignedUrl(s3Key: string): Promise<string> {
    return this.storage.getSignedUrl(s3Key);
  }

  /**
   * Supprime un objet S3. Ne lève pas d'erreur si l'objet n'existe pas.
   * @param s3Key - clé S3 à supprimer
   */
  async deleteImage(s3Key: string): Promise<void> {
    return this.storage.delete(s3Key);
  }
}
