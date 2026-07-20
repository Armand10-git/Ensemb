import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * Wrapper bas niveau S3-compatible (MinIO en dev, S3 en prod).
 * Lit sa configuration via ConfigService — erreur au boot si une variable est absente.
 * Les URLs signées sont générées par ce service ; la clé brute ne doit jamais
 * apparaître dans une réponse HTTP (cf. UploadsController).
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly defaultTtl: number;

  constructor(private readonly config: ConfigService) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.defaultTtl = parseInt(config.getOrThrow<string>('S3_SIGNED_URL_TTL'), 10);

    this.client = new S3Client({
      endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
      region: config.getOrThrow<string>('S3_REGION'),
      credentials: {
        accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
      },
      // Nécessaire pour MinIO : les chemins sont du style /<bucket>/<key>
      forcePathStyle: true,
    });
  }

  /**
   * Uploade un buffer re-encodé vers S3 et retourne la clé S3.
   * @param key - chemin complet : "<orgId>/<type>/<uuid>.<ext>"
   * @param buffer - contenu binaire déjà re-encodé par sharp
   * @param mimeType - MIME type exact de l'image re-encodée
   */
  async upload(
    key: string,
    buffer: Buffer,
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
    return key;
  }

  /**
   * Génère une URL pré-signée GET avec TTL configurable.
   * Ne jamais exposer la clé S3 brute dans une réponse HTTP.
   * @param key - clé S3 persistée en base
   * @param ttlSeconds - durée de validité en secondes (défaut : S3_SIGNED_URL_TTL)
   */
  async getSignedUrl(key: string, ttlSeconds?: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return awsGetSignedUrl(this.client, command, {
      expiresIn: ttlSeconds ?? this.defaultTtl,
    });
  }

  /**
   * Supprime un objet S3. Ne lève pas d'erreur si l'objet n'existe pas
   * (S3/MinIO renvoie 204 dans tous les cas).
   * @param key - clé S3 à supprimer
   */
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
