import { Decimal } from '@prisma/client/runtime/library';
import { renderReturnEmailHtml } from '../return-message.renderer';
import type { ReturnMessageInput, ReturnMessageLine } from '../return-message.renderer';

const baseLine: ReturnMessageLine = {
  productId: 'prod-1',
  productName: 'Sac de riz 25kg',
  quantity: new Decimal('1'),
  price: new Decimal('7000'),
  total: new Decimal('7000'),
};

const baseSaleReturn: ReturnMessageInput = {
  kind: 'sale',
  reference: 'RVT-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'COMPLETED',
  originDocumentReference: 'V-2026-0001',
  counterpartyName: 'Client Test',
  grandTotal: new Decimal('7000'),
  details: [baseLine],
};

describe('renderReturnEmailHtml', () => {
  it('rend un retour de vente avec le vocabulaire "Client" et "Vente d\'origine"', () => {
    const html = renderReturnEmailHtml(baseSaleReturn);

    expect(html).toContain('Récapitulatif de retour de vente');
    expect(html).toContain('RVT-2026-0001');
    expect(html).toContain('Vente d\'origine : V-2026-0001');
    expect(html).toContain('Client : Client Test');
    expect(html).toContain('Validé');
    expect(html).toMatch(/7.?000 XAF/);
  });

  it('rend un retour fournisseur avec le vocabulaire "Fournisseur" et "Achat d\'origine"', () => {
    const purchaseReturn: ReturnMessageInput = {
      ...baseSaleReturn,
      kind: 'purchase',
      reference: 'RAC-2026-0001',
      originDocumentReference: 'ACH-2026-0001',
      counterpartyName: 'Fournisseur Test',
    };

    const html = renderReturnEmailHtml(purchaseReturn);

    expect(html).toContain('Récapitulatif de retour fournisseur');
    expect(html).toContain('RAC-2026-0001');
    expect(html).toContain('Achat d\'origine : ACH-2026-0001');
    expect(html).toContain('Fournisseur : Fournisseur Test');
  });

  it('traduit chaque statut de retour en français', () => {
    expect(renderReturnEmailHtml({ ...baseSaleReturn, status: 'PENDING' })).toContain(
      'En attente de validation',
    );
    expect(renderReturnEmailHtml({ ...baseSaleReturn, status: 'CANCELLED' })).toContain('Annulé');
  });

  it('échappe un nom de client contenant un tag script (anti-injection HTML)', () => {
    const malicious: ReturnMessageInput = {
      ...baseSaleReturn,
      counterpartyName: '<script>alert(1)</script>',
    };

    const html = renderReturnEmailHtml(malicious);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('échappe un nom de produit contenant des balises HTML', () => {
    const malicious: ReturnMessageInput = {
      ...baseSaleReturn,
      details: [{ ...baseLine, productName: '<img src=x onerror=alert(1)>' }],
    };

    const html = renderReturnEmailHtml(malicious);

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('affiche productId si productName est absent', () => {
    const withoutName: ReturnMessageInput = {
      ...baseSaleReturn,
      details: [{ ...baseLine, productName: null }],
    };

    const html = renderReturnEmailHtml(withoutName);

    expect(html).toContain('prod-1');
  });
});
