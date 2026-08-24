import { Decimal } from '@prisma/client/runtime/library';
import { renderQuotationPdfContent, type QuotationPdfInput } from '../quotation-pdf.template';

const BASE_QUOTATION: QuotationPdfInput = {
  reference: 'DEV-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'PENDING',
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
};

describe('renderQuotationPdfContent', () => {
  it('affiche la référence, le client, les lignes et le total général', () => {
    const html = renderQuotationPdfContent(BASE_QUOTATION);

    expect(html).toContain('DEV-2026-0001');
    expect(html).toContain('Client Test');
    expect(html).toContain('Entrepôt Central');
    expect(html).toContain('Produit test');
    expect(html).toContain('Total général');
    expect(html).toMatch(/10.?000 XAF/);
  });

  it('traduit le statut du devis en libellé français et n\'affiche pas de statut de paiement', () => {
    const html = renderQuotationPdfContent(BASE_QUOTATION);

    expect(html).toContain('En attente de validation');
    expect(html).not.toContain('Statut de paiement');
  });

  it('retombe sur le code brut si le statut est inconnu', () => {
    const html = renderQuotationPdfContent({ ...BASE_QUOTATION, status: 'WEIRD_STATUS' });

    expect(html).toContain('WEIRD_STATUS');
  });

  it('affiche un tiret quand le client, l\'entrepôt ou le nom de produit sont absents', () => {
    const html = renderQuotationPdfContent({
      ...BASE_QUOTATION,
      clientName: null,
      warehouseName: null,
      details: [
        {
          productId: 'prod-2',
          productName: null,
          quantity: new Decimal('1'),
          price: new Decimal('1000'),
          total: new Decimal('1000'),
        },
      ],
    });

    expect(html).toContain('—');
    expect(html).toContain('prod-2');
  });

  it('échappe un nom de client contenant une balise script (anti-injection HTML)', () => {
    const html = renderQuotationPdfContent({
      ...BASE_QUOTATION,
      clientName: '<script>alert(1)</script>',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('échappe un nom de produit contenant une balise script (anti-injection HTML)', () => {
    const html = renderQuotationPdfContent({
      ...BASE_QUOTATION,
      details: [
        {
          productId: 'prod-1',
          productName: '<script>alert(2)</script>',
          quantity: new Decimal('1'),
          price: new Decimal('1000'),
          total: new Decimal('1000'),
        },
      ],
    });

    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('n\'affiche pas Remise/Taxe/Livraison quand ils sont nuls ou à zéro', () => {
    const html = renderQuotationPdfContent({
      ...BASE_QUOTATION,
      discount: new Decimal('0'),
      taxAmount: new Decimal('0'),
      shipping: null,
    });

    expect(html).not.toContain('Remise');
    expect(html).not.toContain('Taxe');
    expect(html).not.toContain('Livraison');
  });

  it('affiche Remise/Taxe/Livraison quand ils sont positifs', () => {
    const html = renderQuotationPdfContent({
      ...BASE_QUOTATION,
      discount: new Decimal('500'),
      taxAmount: new Decimal('1000'),
      shipping: new Decimal('200'),
    });

    expect(html).toContain('Remise');
    expect(html).toContain('Taxe');
    expect(html).toContain('Livraison');
  });

  it('calcule le sous-total en Decimal à partir de la somme des lignes', () => {
    const html = renderQuotationPdfContent({
      ...BASE_QUOTATION,
      details: [
        {
          productId: 'prod-1',
          productName: 'A',
          quantity: new Decimal('1'),
          price: new Decimal('3000'),
          total: new Decimal('3000'),
        },
        {
          productId: 'prod-2',
          productName: 'B',
          quantity: new Decimal('1'),
          price: new Decimal('4000'),
          total: new Decimal('4000'),
        },
      ],
    });

    expect(html).toContain('Sous-total');
    expect(html).toMatch(/7.?000 XAF/);
  });
});
