/**
 * Mock CJS-compatible de @otplib/plugin-base32-scure.
 * Implémente l'interface Base32Plugin d'otplib v13 via notre mock @scure/base.
 * Conforme à l'interface Base32Plugin : encode() accepte options, decode() retourne Uint8Array.
 */
import { base32 } from '@scure/base';

export class ScureBase32Plugin {
  readonly name = 'mock-scure';

  encode(data: Uint8Array, options?: { padding?: boolean }): string {
    const { padding = false } = options ?? {};
    const encoded = base32.encode(data);
    return padding ? encoded : encoded.replace(/=+$/, '');
  }

  decode(str: string): Uint8Array {
    try {
      const upper = str.toUpperCase();
      const padded = upper.padEnd(Math.ceil(upper.length / 8) * 8, '=');
      return base32.decode(padded);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid Base32 string: ${msg}`);
    }
  }
}
