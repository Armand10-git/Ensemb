import { UpdateBrandingSchema } from '../dto/update-branding.dto';

describe('UpdateBrandingSchema', () => {
  it('accepte logoUrl seul', () => {
    const result = UpdateBrandingSchema.safeParse({ logoUrl: 'https://cdn.example.com/logo.png' });
    expect(result.success).toBe(true);
  });

  it('accepte primaryColor seul', () => {
    const result = UpdateBrandingSchema.safeParse({ primaryColor: '#3B82F6' });
    expect(result.success).toBe(true);
  });

  it('accepte logoUrl et primaryColor ensemble', () => {
    const result = UpdateBrandingSchema.safeParse({
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#3B82F6',
    });
    expect(result.success).toBe(true);
  });

  it('rejette un objet vide (aucun champ)', () => {
    const result = UpdateBrandingSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejette primaryColor sans #', () => {
    const result = UpdateBrandingSchema.safeParse({ primaryColor: '3B82F6' });
    expect(result.success).toBe(false);
  });

  it('rejette primaryColor avec des caractères hors HEX', () => {
    const result = UpdateBrandingSchema.safeParse({ primaryColor: '#GGGGGG' });
    expect(result.success).toBe(false);
  });

  it('rejette primaryColor à 3 chiffres', () => {
    const result = UpdateBrandingSchema.safeParse({ primaryColor: '#3B8' });
    expect(result.success).toBe(false);
  });

  it('rejette logoUrl non-URL', () => {
    const result = UpdateBrandingSchema.safeParse({ logoUrl: 'pas-une-url' });
    expect(result.success).toBe(false);
  });

  it('rejette logoUrl dépassant 2048 caractères', () => {
    const result = UpdateBrandingSchema.safeParse({ logoUrl: `https://example.com/${'a'.repeat(2048)}` });
    expect(result.success).toBe(false);
  });
});
