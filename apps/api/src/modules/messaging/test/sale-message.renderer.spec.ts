import { Decimal } from '@prisma/client/runtime/library';
import { renderSaleEmailHtml, renderSaleSmsBody } from '../sale-message.renderer';
import type { SaleMessageInput, SaleMessageLine } from '../sale-message.renderer';

const baseLine: SaleMessageLine = {
  productId: 'prod-1',
  productName: 'Sac de riz 25kg',
  quantity: new Decimal('2'),
  price: new Decimal('7000'),
  total: new Decimal('14000'),
};

const baseSale: SaleMessageInput = {
  reference: 'V-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  paymentStatus: 'PARTIAL',
  clientName: 'Client Test',
  grandTotal: new Decimal('15000'),
  details: [baseLine],
};

describe('renderSaleEmailHtml', () => {
  it('contient la reference, le statut, les lignes et le nom du client attendus', () => {
    const html = renderSaleEmailHtml(baseSale);

    expect(html).toContain('V-2026-0001');
    expect(html).toContain('Sac de riz 25kg');
    expect(html).toContain('Partiellement payée');
    expect(html).toContain('Client Test');
  });

  it('affiche le total general et le total de la ligne', () => {
    const html = renderSaleEmailHtml(baseSale);
    // toLocaleString('fr-FR') peut produire une espace normale ou insecable selon l'environnement Node —
    // on verifie la presence des chiffres et de la devise plutot que l'espace exacte.
    expect(html).toMatch(/15.?000 XAF/);
    expect(html).toMatch(/14.?000 XAF/);
  });

  it('echappe un nom de client contenant un tag script (anti-injection HTML)', () => {
    const malicious: SaleMessageInput = {
      ...baseSale,
      clientName: '<script>alert(1)</script>',
    };

    const html = renderSaleEmailHtml(malicious);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('echappe un nom de produit contenant des balises HTML', () => {
    const malicious: SaleMessageInput = {
      ...baseSale,
      details: [{ ...baseLine, productName: '<img src=x onerror=alert(1)>' }],
    };

    const html = renderSaleEmailHtml(malicious);

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('affiche productId si productName est absent', () => {
    const withoutName: SaleMessageInput = {
      ...baseSale,
      details: [{ ...baseLine, productName: null }],
    };

    const html = renderSaleEmailHtml(withoutName);

    expect(html).toContain('prod-1');
  });
});

describe('renderSaleSmsBody', () => {
  it('contient la reference et le total', () => {
    const body = renderSaleSmsBody(baseSale);

    expect(body).toContain('V-2026-0001');
    expect(body).toMatch(/15.?000 XAF/);
  });

  it('reste un texte court sans balise HTML', () => {
    const body = renderSaleSmsBody(baseSale);
    expect(body).not.toMatch(/<[^>]+>/);
  });
});
