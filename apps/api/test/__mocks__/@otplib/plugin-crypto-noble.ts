/**
 * Mock CJS-compatible de @otplib/plugin-crypto-noble.
 * Implémente l'interface CryptoPlugin d'otplib v13 via Node.js crypto natif.
 * Remplace @noble/hashes (ESM-only) par Node.js crypto natif (createHmac,
 * randomBytes, timingSafeEqual).
 */
import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'crypto';

export class NobleCryptoPlugin {
  readonly name = 'mock-node';

  hmac(algorithm: string, key: Uint8Array, data: Uint8Array): Uint8Array {
    const h = createHmac(algorithm, Buffer.from(key));
    h.update(Buffer.from(data));
    return new Uint8Array(h.digest());
  }

  randomBytes(length: number): Uint8Array {
    return new Uint8Array(nodeRandomBytes(length));
  }

  constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
    const bufA = typeof a === 'string' ? Buffer.from(a) : Buffer.from(a);
    const bufB = typeof b === 'string' ? Buffer.from(b) : Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
