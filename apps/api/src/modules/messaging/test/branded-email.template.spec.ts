import { wrapBrandedEmail } from '../branded-email.template';

describe('wrapBrandedEmail', () => {
  it('injecte le logo et la couleur de l\'organisation quand ils sont présents', () => {
    const html = wrapBrandedEmail('<p>contenu</p>', {
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#3B82F6',
    });

    expect(html).toContain('https://cdn.example.com/logo.png');
    expect(html).toContain('#3B82F6');
    expect(html).toContain('<p>contenu</p>');
  });

  it('retombe sur la couleur brand par défaut si primaryColor est absent', () => {
    const html = wrapBrandedEmail('<p>contenu</p>', { logoUrl: null, primaryColor: null });

    expect(html).toContain('#2FA75E');
  });

  it('retombe sur la couleur brand par défaut si primaryColor ne respecte pas le format HEX 6 chiffres', () => {
    const html = wrapBrandedEmail('<p>contenu</p>', {
      logoUrl: null,
      primaryColor: 'javascript:alert(1)',
    });

    expect(html).toContain('#2FA75E');
    expect(html).not.toContain('javascript:alert(1)');
  });

  it("n'affiche aucune image si logoUrl est absent", () => {
    const html = wrapBrandedEmail('<p>contenu</p>', { logoUrl: null, primaryColor: null });

    expect(html).not.toContain('<img');
  });

  it('échappe logoUrl avant insertion (anti-injection HTML)', () => {
    const html = wrapBrandedEmail('<p>contenu</p>', {
      logoUrl: 'https://evil.example.com/x.png" onerror="alert(1)',
      primaryColor: null,
    });

    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&quot;');
  });
});
