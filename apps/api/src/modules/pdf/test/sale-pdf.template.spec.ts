import { Decimal } from '@prisma/client/runtime/library';
import { renderSalePdfContent, SalePdfInput } from '../sale-pdf.template';

/** Vente factice minimale — mirror du patron de fixtures des tests de renderers messaging. */
function makeSale(overrides: Partial<SalePdfInput> = {}): SalePdfInput {
  return {
    reference: 'V-2026-0001',
    date: new Date('2026-07-29T10:00:00Z'),
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    clientName: 'Client Test',
    warehouseName: 'Entrepôt Central',
    discount: null,
    taxAmount: null,
    shipping: null,
    grandTotal: new Decimal('10000'),
    details: [
      {
        productId: 'prod-1',
        productName: 'Produit test',
        quantity: new Decimal('2'),
        price: new Decimal('5000'),
        total: new Decimal('10000'),
      },
    ],
    ...overrides,
  };
}

describe('renderSalePdfContent', () => {
  it('affiche la référence, le client, l\'entrepôt et les lignes', () => {
    const html = renderSalePdfContent(makeSale());

    expect(html).toContain('V-2026-0001');
    expect(html).toContain('Client Test');
    expect(html).toContain('Entrepôt Central');
    expect(html).toContain('Produit test');
    expect(html).toContain('2');
  });

  it('affiche le total général formaté', () => {
    const html = renderSalePdfContent(makeSale());
    expect(html).toContain('Total général');
    // toLocaleString('fr-FR') peut produire une espace normale ou insecable selon
    // l'environnement Node — on vérifie la présence des chiffres et de la devise plutôt
    // que l'espace exacte (mirror sale-message.renderer.spec.ts).
    expect(html).toMatch(/10.?000 XAF/);
  });

  it('affiche les libellés de statut et de statut de paiement', () => {
    const html = renderSalePdfContent(
      makeSale({ status: 'PENDING', paymentStatus: 'PARTIAL' }),
    );
    expect(html).toContain('En attente de validation');
    expect(html).toContain('Partiellement payée');
  });

  it('retombe sur le code brut pour un statut inconnu (défensif)', () => {
    const html = renderSalePdfContent(makeSale({ status: 'WEIRD_STATUS' }));
    expect(html).toContain('WEIRD_STATUS');
  });

  it('affiche — quand client/entrepôt sont absents', () => {
    const html = renderSalePdfContent(
      makeSale({ clientName: null, warehouseName: null }),
    );
    expect(html).toContain('Client : —');
    expect(html).toContain('Entrepôt : —');
  });

  it('échappe un nom de client contenant une balise script (anti-XSS)', () => {
    const html = renderSalePdfContent(
      makeSale({ clientName: '<script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('échappe un nom de produit malveillant', () => {
    const html = renderSalePdfContent(
      makeSale({
        details: [
          {
            productId: 'prod-1',
            productName: '<img src=x onerror=alert(1)>',
            quantity: new Decimal('1'),
            price: new Decimal('1000'),
            total: new Decimal('1000'),
          },
        ],
      }),
    );
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('utilise productId si productName est absent', () => {
    const html = renderSalePdfContent(
      makeSale({
        details: [
          {
            productId: 'prod-sans-nom',
            quantity: new Decimal('1'),
            price: new Decimal('1000'),
            total: new Decimal('1000'),
          },
        ],
      }),
    );
    expect(html).toContain('prod-sans-nom');
  });

  it('n\'affiche pas Remise/Taxe/Livraison quand les montants sont null ou zéro', () => {
    const html = renderSalePdfContent(
      makeSale({
        discount: new Decimal('0'),
        taxAmount: null,
        shipping: new Decimal('0'),
      }),
    );
    expect(html).not.toContain('Remise');
    expect(html).not.toContain('Taxe');
    expect(html).not.toContain('Livraison');
  });

  it('affiche Remise/Taxe/Livraison quand les montants sont > 0', () => {
    const html = renderSalePdfContent(
      makeSale({
        discount: new Decimal('500'),
        taxAmount: new Decimal('1000'),
        shipping: new Decimal('250'),
      }),
    );
    expect(html).toContain('Remise');
    expect(html).toContain('Taxe');
    expect(html).toContain('Livraison');
  });

  it('calcule le sous-total en Decimal comme somme des totaux de ligne', () => {
    const html = renderSalePdfContent(
      makeSale({
        details: [
          {
            productId: 'p1',
            productName: 'A',
            quantity: new Decimal('1'),
            price: new Decimal('3000'),
            total: new Decimal('3000'),
          },
          {
            productId: 'p2',
            productName: 'B',
            quantity: new Decimal('1'),
            price: new Decimal('7000'),
            total: new Decimal('7000'),
          },
        ],
      }),
    );
    expect(html).toContain('Sous-total');
    expect(html).toMatch(/10.?000 XAF/);
  });
});
