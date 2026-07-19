import { RegisterOrganizationSchema, RESERVED_SUBDOMAINS } from '../dto/register-organization.dto';

const VALID = {
  subdomain: 'boutique-durand',
  organizationName: 'Boutique Durand',
  adminFirstname: 'Jean',
  adminLastname: 'Durand',
  adminEmail: 'jean@boutique-durand.com',
  adminPassword: 'MotDePasse123',
};

describe('RegisterOrganizationSchema', () => {
  it('valide un DTO correct', () => {
    expect(RegisterOrganizationSchema.safeParse(VALID).success).toBe(true);
  });

  describe('subdomain', () => {
    it.each(RESERVED_SUBDOMAINS)('rejette le sous-domaine reserve "%s"', (reserved) => {
      const result = RegisterOrganizationSchema.safeParse({ ...VALID, subdomain: reserved });
      expect(result.success).toBe(false);
    });

    it('rejette un sous-domaine commencant par un tiret', () => {
      expect(RegisterOrganizationSchema.safeParse({ ...VALID, subdomain: '-invalid' }).success).toBe(false);
    });

    it('rejette un sous-domaine se terminant par un tiret', () => {
      expect(RegisterOrganizationSchema.safeParse({ ...VALID, subdomain: 'invalid-' }).success).toBe(false);
    });

    it('rejette un sous-domaine avec majuscules', () => {
      expect(RegisterOrganizationSchema.safeParse({ ...VALID, subdomain: 'Boutique' }).success).toBe(false);
    });

    it('rejette un sous-domaine vide', () => {
      expect(RegisterOrganizationSchema.safeParse({ ...VALID, subdomain: '' }).success).toBe(false);
    });

    it('rejette un sous-domaine de plus de 63 caracteres', () => {
      const long = 'a'.repeat(64);
      expect(RegisterOrganizationSchema.safeParse({ ...VALID, subdomain: long }).success).toBe(false);
    });

    it('accepte un sous-domaine avec chiffres et tirets internes', () => {
      const result = RegisterOrganizationSchema.safeParse({ ...VALID, subdomain: 'shop123-durand' });
      expect(result.success).toBe(true);
    });
  });

  describe('adminPassword', () => {
    it('rejette un mot de passe de moins de 8 caracteres', () => {
      expect(RegisterOrganizationSchema.safeParse({ ...VALID, adminPassword: '1234567' }).success).toBe(false);
    });

    it('accepte un mot de passe d\'exactement 8 caracteres', () => {
      expect(RegisterOrganizationSchema.safeParse({ ...VALID, adminPassword: '12345678' }).success).toBe(true);
    });
  });

  describe('adminEmail', () => {
    it('rejette un email invalide', () => {
      expect(RegisterOrganizationSchema.safeParse({ ...VALID, adminEmail: 'pas-un-email' }).success).toBe(false);
    });
  });
});
