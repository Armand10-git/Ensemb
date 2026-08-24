import { wrapBrandedPdf } from '../branded-pdf.template';

describe('wrapBrandedPdf', () => {
  it('injecte le nom, le logo et la couleur de l\'organisation quand ils sont présents', () => {
    const html = wrapBrandedPdf('Facture VTE-2026-000001', '<p>contenu</p>', {
      name: 'Boutique Ensemb',
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#3B82F6',
    });

    expect(html).toContain('Boutique Ensemb');
    expect(html).toContain('https://cdn.example.com/logo.png');
    expect(html).toContain('#3B82F6');
    expect(html).toContain('<p>contenu</p>');
    expect(html).toContain('Facture VTE-2026-000001');
  });

  it('retombe sur la couleur brand par défaut si primaryColor est absent ou invalide', () => {
    const html = wrapBrandedPdf('Titre', '<p>contenu</p>', {
      name: 'Org',
      logoUrl: null,
      primaryColor: 'javascript:alert(1)',
    });

    expect(html).toContain('#2FA75E');
    expect(html).not.toContain('javascript:alert(1)');
  });

  it("n'affiche aucune image si logoUrl est absent", () => {
    const html = wrapBrandedPdf('Titre', '<p>contenu</p>', {
      name: 'Org',
      logoUrl: null,
      primaryColor: null,
    });

    expect(html).not.toContain('<img');
  });

  it('échappe le nom de l\'organisation et logoUrl avant insertion (anti-injection HTML)', () => {
    const html = wrapBrandedPdf('Titre', '<p>contenu</p>', {
      name: '<script>alert(1)</script>',
      logoUrl: 'https://evil.example.com/x.png" onerror="alert(1)',
      primaryColor: null,
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('onerror="alert(1)"');
  });

  it('produit un document HTML autonome (doctype, A4)', () => {
    const html = wrapBrandedPdf('Titre', '<p>x</p>', { name: 'Org', logoUrl: null, primaryColor: null });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('size: A4');
  });
});
