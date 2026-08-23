import { Decimal } from '@prisma/client/runtime/library';
import { renderPaymentReceiptEmailHtml } from '../payment-receipt-message.renderer';
import type { PaymentReceiptMessageInput } from '../payment-receipt-message.renderer';

const baseSaleReceipt: PaymentReceiptMessageInput = {
  kind: 'sale',
  reference: 'PAY-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  amount: new Decimal('5000'),
  method: 'CASH',
  change: new Decimal('0'),
  documentReference: 'V-2026-0001',
  counterpartyName: 'Client Test',
};

describe('renderPaymentReceiptEmailHtml', () => {
  it('rend un reçu de paiement de vente avec le vocabulaire "Client" et "vente"', () => {
    const html = renderPaymentReceiptEmailHtml(baseSaleReceipt);

    expect(html).toContain('PAY-2026-0001');
    expect(html).toContain('V-2026-0001');
    expect(html).toContain('Client : Client Test');
    expect(html).toContain('(vente)');
    expect(html).toContain('Espèces');
    expect(html).toMatch(/5.?000 XAF/);
  });

  it('rend un reçu de paiement d\'achat avec le vocabulaire "Fournisseur" et "achat"', () => {
    const purchaseReceipt: PaymentReceiptMessageInput = {
      ...baseSaleReceipt,
      kind: 'purchase',
      reference: 'PAA-2026-0001',
      documentReference: 'ACH-2026-0001',
      counterpartyName: 'Fournisseur Test',
    };

    const html = renderPaymentReceiptEmailHtml(purchaseReceipt);

    expect(html).toContain('PAA-2026-0001');
    expect(html).toContain('ACH-2026-0001');
    expect(html).toContain('Fournisseur : Fournisseur Test');
    expect(html).toContain('(achat)');
  });

  it('affiche la monnaie rendue uniquement si non nulle', () => {
    const withChange = renderPaymentReceiptEmailHtml({ ...baseSaleReceipt, change: new Decimal('500') });
    expect(withChange).toContain('Monnaie rendue');

    const withoutChange = renderPaymentReceiptEmailHtml({ ...baseSaleReceipt, change: new Decimal('0') });
    expect(withoutChange).not.toContain('Monnaie rendue');
  });

  it('traduit chaque moyen de paiement en français', () => {
    expect(renderPaymentReceiptEmailHtml({ ...baseSaleReceipt, method: 'CARD' })).toContain('Carte bancaire');
    expect(renderPaymentReceiptEmailHtml({ ...baseSaleReceipt, method: 'MOBILE_MONEY' })).toContain('Mobile Money');
    expect(renderPaymentReceiptEmailHtml({ ...baseSaleReceipt, method: 'BANK_TRANSFER' })).toContain(
      'Virement bancaire',
    );
  });

  it('échappe un nom de client contenant un tag script (anti-injection HTML)', () => {
    const malicious: PaymentReceiptMessageInput = {
      ...baseSaleReceipt,
      counterpartyName: '<script>alert(1)</script>',
    };

    const html = renderPaymentReceiptEmailHtml(malicious);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
