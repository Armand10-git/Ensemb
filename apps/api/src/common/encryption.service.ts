import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — standard GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Chiffrement AES-256-GCM des secrets tenant (§17 point S).
 * Clé maîtresse lue depuis APP_ENCRYPTION_KEY — erreur au boot si absente.
 * Format stocké en base : "iv:authTag:ciphertext" (hex).
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const raw = this.config.getOrThrow<string>('APP_ENCRYPTION_KEY');
    // Dériver une clé 32 octets depuis la valeur env (SHA-256 pour la normaliser)
    this.key = crypto.createHash('sha256').update(raw).digest();
  }

  /**
   * Chiffre un secret en AES-256-GCM.
   * @returns "iv:authTag:ciphertext" en hex
   */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Déchiffre un secret au format "iv:authTag:ciphertext".
   * Lève une erreur si la clé est mauvaise, le tag invalide, ou le format incorrect.
   */
  decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Format de chiffrement invalide — attendu "iv:authTag:ciphertext"');
    }
    // length === 3 garantit que ces index existent — non-null assertion safe après la garde ci-dessus
    const ivHex = parts[0] as string;
    const authTagHex = parts[1] as string;
    const dataHex = parts[2] as string;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    try {
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Déchiffrement échoué — clé incorrecte ou données altérées');
    }
  }
}
