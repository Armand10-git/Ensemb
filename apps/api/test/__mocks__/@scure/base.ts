/**
 * Mock CJS-compatible de @scure/base (ESM-only) pour les tests Jest.
 * Implémente uniquement base32 (RFC 4648) utilisé par @otplib/plugin-base32-scure.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALPHABET_MAP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]!] = i;

function encode(data: Uint8Array): string {
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += ALPHABET[(value << (5 - bits)) & 31];
  while (result.length % 8 !== 0) result += '=';
  return result;
}

function decode(str: string): Uint8Array {
  str = str.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of str) {
    const idx = ALPHABET_MAP[char];
    if (idx === undefined) throw new Error(`Char invalide base32 : ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export const base32 = { encode, decode };
export const base32nopad = { encode, decode };
export const base64 = {
  encode: (data: Uint8Array) => Buffer.from(data).toString('base64'),
  decode: (str: string) => new Uint8Array(Buffer.from(str, 'base64')),
};
export const utils = Object.freeze({
  alphabet: ALPHABET,
});
