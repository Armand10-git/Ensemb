import { Decimal } from '@prisma/client/runtime/library';
import { renderReturnPdfContent, type ReturnPdfInput } from '../return-pdf.template';

const BASE_SALE_RETURN: ReturnPdfInput = {
  kind: 'sale',
  reference: 'RVT-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  originDocumentReference: 'V-2026-0001',
  counterpartyName: 'Client Test',
  warehouseName: 'Entrepôt Central',
  discount: null,
  taxAmount: null,
  shipping: null,
  grandTotal: new Decimal('7000'),
  details: [
    {
      productId: 'prod-1',
      productName: 'Produit test',
      quantity: new Decimal('1'),
      price: new Decimal('7000'),
      total: new Decimal('7000'),
    },
  ],
};

const BASE_PURCHASE_RETURN: ReturnPdfInput = {
  ...BASE_SALE_RETURN,
  kind: 'purchase',
  reference: 'RAC-2026-0001',
  originDocumentReference: 'ACH-2026-0001',
  counterpartyName: 'Fournisseur Test',
};

describe('renderReturnPdfContent', () => {
  describe('kind: sale', () => {
    it('affiche le vocabulaire Vente/Client et les données du retour', () => {
      const html = renderReturnPdfContent(BASE_SALE_RETURN);

      expect(html).toContain('RVT-2026-0001');
      expect(html).toContain('Vente d\'origine');
      expect(html).toContain('V-2026-0001');
      expect(html).toContain('Client :');
      expect(html).toContain('Client Test');
      expect(html).toContain('Produit test');
      expect(html).toContain('Total général');
      expect(html).toMatch(/7.?000 XAF/);
      expect(html).not.toContain('Fournisseur');
    });

    it('traduit statut et statut de paiement en libellés français', () => {
      const html = renderReturnPdfContent(BASE_SALE_RETURN);

      expect(html).toContain('Validé');
      expect(html).toContain('Payé');
    });
  });

  describe('kind: purchase', () => {
    it('affiche le vocabulaire Achat/Fournisseur et les données du retour', () => {
      const html = renderReturnPdfContent(BASE_PURCHASE_RETURN);

      expect(html).toContain('RAC-2026-0001');
      expect(html).toContain('Achat d\'origine');
      expect(html).toContain('ACH-2026-0001');
      expect(html).toContain('Fournisseur :');
      expect(html).toContain('Fournisseur Test');
      expect(html).not.toContain('Client :');
    });
  });

  it('retombe sur le code brut si statut ou statut de paiement sont inconnus', () => {
    const html = renderReturnPdfContent({
      ...BASE_SALE_RETURN,
      status: 'WEIRD_STATUS',
      paymentStatus: 'WEIRD_PAYMENT',
    });

    expect(html).toContain('WEIRD_STATUS');
    expect(html).toContain('WEIRD_PAYMENT');
  });

  it('affiche un tiret quand la contrepartie, l\'entrepôt ou le nom de produit sont absents', () => {
    const html = renderReturnPdfContent({
      ...BASE_SALE_RETURN,
      counterpartyName: null,
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

  it('échappe un nom de contrepartie (client/fournisseur) contenant une balise script (anti-injection HTML)', () => {
    const htmlSale = renderReturnPdfContent({
      ...BASE_SALE_RETURN,
      counterpartyName: '<script>alert(1)</script>',
    });
    expect(htmlSale).not.toContain('<script>alert(1)</script>');
    expect(htmlSale).toContain('&lt;script&gt;');

    const htmlPurchase = renderReturnPdfContent({
      ...BASE_PURCHASE_RETURN,
      counterpartyName: '<script>alert(2)</script>',
    });
    expect(htmlPurchase).not.toContain('<script>alert(2)</script>');
    expect(htmlPurchase).toContain('&lt;script&gt;');
  });

  it('échappe un nom de produit contenant une balise script (anti-injection HTML)', () => {
    const html = renderReturnPdfContent({
      ...BASE_SALE_RETURN,
      details: [
        {
          productId: 'prod-1',
          productName: '<script>alert(3)</script>',
          quantity: new Decimal('1'),
          price: new Decimal('1000'),
          total: new Decimal('1000'),
        },
      ],
    });

    expect(html).not.toContain('<script>alert(3)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('n\'affiche pas Remise/Taxe/Livraison quand ils sont nuls ou à zéro', () => {
    const html = renderReturnPdfContent({
      ...BASE_SALE_RETURN,
      discount: new Decimal('0'),
      taxAmount: new Decimal('0'),
      shipping: null,
    });

    expect(html).not.toContain('Remise');
    expect(html).not.toContain('Taxe');
    expect(html).not.toContain('Livraison');
  });

  it('affiche Remise/Taxe/Livraison quand ils sont positifs', () => {
    const html = renderReturnPdfContent({
      ...BASE_SALE_RETURN,
      discount: new Decimal('500'),
      taxAmount: new Decimal('1000'),
      shipping: new Decimal('200'),
    });

    expect(html).toContain('Remise');
    expect(html).toContain('Taxe');
    expect(html).toContain('Livraison');
  });

  it('calcule le sous-total en Decimal à partir de la somme des lignes', () => {
    const html = renderReturnPdfContent({
      ...BASE_SALE_RETURN,
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
