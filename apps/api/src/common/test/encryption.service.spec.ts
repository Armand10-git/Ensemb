import { EncryptionService } from '../encryption.service';

const KEY = 'test-key-for-unit-tests-only-32ch';

const makeService = (key = KEY) => {
  const config = { getOrThrow: jest.fn().mockReturnValue(key) };
  const svc = new EncryptionService(config as never);
  svc.onModuleInit();
  return svc;
};

describe('EncryptionService', () => {
  describe('round-trip', () => {
    it('decrypt(encrypt(x)) === x', () => {
      const svc = makeService();
      const plain = 'MonMotDePasse123!';
      expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
    });

    it('fonctionne avec des chaînes vides', () => {
      const svc = makeService();
      expect(svc.decrypt(svc.encrypt(''))).toBe('');
    });

    it('fonctionne avec des caractères unicode', () => {
      const svc = makeService();
      const plain = 'Mòt dé 🔑 pàssé';
      expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
    });
  });

  describe('IV aléatoire', () => {
    it('deux appels encrypt sur le même plaintext produisent deux chiffrés différents', () => {
      const svc = makeService();
      const plain = 'secret';
      const c1 = svc.encrypt(plain);
      const c2 = svc.encrypt(plain);
      expect(c1).not.toBe(c2);
    });
  });

  describe('format de sortie', () => {
    it('le chiffré contient exactement deux séparateurs ":"', () => {
      const svc = makeService();
      const parts = svc.encrypt('x').split(':');
      expect(parts).toHaveLength(3);
      // chaque segment est une chaîne hex non vide
      parts.forEach((p) => {
        expect(p.length).toBeGreaterThan(0);
        expect(/^[0-9a-f]+$/.test(p)).toBe(true);
      });
    });
  });

  describe('sécurité déchiffrement', () => {
    it('lève une erreur si la clé est différente', () => {
      const svc1 = makeService('key-one-32-characters-padding!!!');
      const svc2 = makeService('key-two-32-characters-padding!!!');
      const cipher = svc1.encrypt('secret');
      expect(() => svc2.decrypt(cipher)).toThrow();
    });

    it('lève une erreur si le format est invalide (pas de ":")', () => {
      const svc = makeService();
      expect(() => svc.decrypt('not-a-valid-ciphertext')).toThrow(
        'Format de chiffrement invalide',
      );
    });

    it('lève une erreur si le format n\'a qu\'un seul ":"', () => {
      const svc = makeService();
      expect(() => svc.decrypt('aabbcc:ddeeff')).toThrow(
        'Format de chiffrement invalide',
      );
    });

    it('lève une erreur si le ciphertext est altéré', () => {
      const svc = makeService();
      const parts = svc.encrypt('secret').split(':');
      const iv = parts[0] as string;
      const authTag = parts[1] as string;
      const data = parts[2] as string;
      // Altère le premier octet du chiffré
      const alteredData = 'ff' + data.slice(2);
      expect(() => svc.decrypt(`${iv}:${authTag}:${alteredData}`)).toThrow();
    });
  });

  describe('init', () => {
    it('lève une erreur au boot si APP_ENCRYPTION_KEY est absente', () => {
      const config = { getOrThrow: jest.fn().mockImplementation(() => { throw new Error('Config manquante'); }) };
      const svc = new EncryptionService(config as never);
      expect(() => svc.onModuleInit()).toThrow('Config manquante');
    });
  });
});
