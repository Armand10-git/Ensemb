import { Decimal } from '@prisma/client/runtime/library';
import { renderPurchaseEmailHtml, renderPurchaseSmsBody } from '../purchase-message.renderer';
import type { PurchaseMessageInput, PurchaseMessageLine } from '../purchase-message.renderer';

const baseLine: PurchaseMessageLine = {
  productId: 'prod-1',
  productName: 'Sac de riz 25kg',
  quantity: new Decimal('2'),
  price: new Decimal('7000'),
  total: new Decimal('14000'),
};

const basePurchase: PurchaseMessageInput = {
  reference: 'ACH-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  paymentStatus: 'PARTIAL',
  providerName: 'Fournisseur Test',
  grandTotal: new Decimal('15000'),
  details: [baseLine],
};

describe('renderPurchaseEmailHtml', () => {
  it('contient la référence, le statut, les lignes et le nom du fournisseur attendus', () => {
    const html = renderPurchaseEmailHtml(basePurchase);

    expect(html).toContain('ACH-2026-0001');
    expect(html).toContain('Sac de riz 25kg');
    expect(html).toContain('Partiellement payé');
    expect(html).toContain('Fournisseur Test');
  });

  it('affiche le total général et le total de la ligne', () => {
    const html = renderPurchaseEmailHtml(basePurchase);
    expect(html).toMatch(/15.?000 XAF/);
    expect(html).toMatch(/14.?000 XAF/);
  });

  it('échappe un nom de fournisseur contenant un tag script (anti-injection HTML)', () => {
    const malicious: PurchaseMessageInput = {
      ...basePurchase,
      providerName: '<script>alert(1)</script>',
    };

    const html = renderPurchaseEmailHtml(malicious);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('échappe un nom de produit contenant des balises HTML', () => {
    const malicious: PurchaseMessageInput = {
      ...basePurchase,
      details: [{ ...baseLine, productName: '<img src=x onerror=alert(1)>' }],
    };

    const html = renderPurchaseEmailHtml(malicious);

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('affiche productId si productName est absent', () => {
    const withoutName: PurchaseMessageInput = {
      ...basePurchase,
      details: [{ ...baseLine, productName: null }],
    };

    const html = renderPurchaseEmailHtml(withoutName);

    expect(html).toContain('prod-1');
  });
});

describe('renderPurchaseSmsBody', () => {
  it('contient la référence, le total et le statut', () => {
    const body = renderPurchaseSmsBody(basePurchase);

    expect(body).toContain('ACH-2026-0001');
    expect(body).toMatch(/15.?000 XAF/);
    expect(body).toContain('Partiellement payé');
  });

  it('ne contient pas le nom du fournisseur (texte court)', () => {
    const body = renderPurchaseSmsBody(basePurchase);

    expect(body).not.toContain('Fournisseur Test');
  });

  it('reste un texte court sans balise HTML', () => {
    const body = renderPurchaseSmsBody(basePurchase);

    expect(body).not.toMatch(/<[^>]+>/);
  });
});
