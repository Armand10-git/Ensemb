import { Decimal } from '@prisma/client/runtime/library';
import { renderQuotationEmailHtml, renderQuotationSmsBody } from '../quotation-message.renderer';
import type { QuotationMessageInput, QuotationMessageLine } from '../quotation-message.renderer';

const baseLine: QuotationMessageLine = {
  productId: 'prod-1',
  productName: 'Sac de riz 25kg',
  quantity: new Decimal('2'),
  price: new Decimal('7000'),
  total: new Decimal('14000'),
};

const baseQuotation: QuotationMessageInput = {
  reference: 'DEV-2026-0001',
  date: new Date('2026-07-29T10:00:00Z'),
  status: 'PENDING',
  clientName: 'Client Test',
  grandTotal: new Decimal('15000'),
  details: [baseLine],
};

describe('renderQuotationEmailHtml', () => {
  it('contient la reference, le statut, les lignes et le nom du client attendus', () => {
    const html = renderQuotationEmailHtml(baseQuotation);

    expect(html).toContain('DEV-2026-0001');
    expect(html).toContain('Sac de riz 25kg');
    expect(html).toContain('En attente de validation');
    expect(html).toContain('Client Test');
  });

  it('affiche le total general et le total de la ligne', () => {
    const html = renderQuotationEmailHtml(baseQuotation);
    // toLocaleString('fr-FR') peut produire une espace normale ou insecable selon l'environnement Node —
    // on verifie la presence des chiffres et de la devise plutot que l'espace exacte.
    expect(html).toMatch(/15.?000 XAF/);
    expect(html).toMatch(/14.?000 XAF/);
  });

  it('echappe un nom de client contenant un tag script (anti-injection HTML)', () => {
    const malicious: QuotationMessageInput = {
      ...baseQuotation,
      clientName: '<script>alert(1)</script>',
    };

    const html = renderQuotationEmailHtml(malicious);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('echappe un nom de produit contenant des balises HTML', () => {
    const malicious: QuotationMessageInput = {
      ...baseQuotation,
      details: [{ ...baseLine, productName: '<img src=x onerror=alert(1)>' }],
    };

    const html = renderQuotationEmailHtml(malicious);

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('affiche productId si productName est absent', () => {
    const withoutName: QuotationMessageInput = {
      ...baseQuotation,
      details: [{ ...baseLine, productName: null }],
    };

    const html = renderQuotationEmailHtml(withoutName);

    expect(html).toContain('prod-1');
  });

  it.each([
    ['PENDING', 'En attente de validation'],
    ['COMPLETED', 'Converti en vente'],
    ['CANCELLED', 'Annulé'],
  ])('traduit le statut %s en libellé "%s"', (status, label) => {
    const html = renderQuotationEmailHtml({ ...baseQuotation, status });
    expect(html).toContain(label);
  });

  it('retombe sur le code brut pour un statut inconnu', () => {
    const html = renderQuotationEmailHtml({ ...baseQuotation, status: 'AWAITING_PAYMENT' });
    expect(html).toContain('AWAITING_PAYMENT');
  });
});

describe('renderQuotationSmsBody', () => {
  it('contient la reference et le total', () => {
    const body = renderQuotationSmsBody(baseQuotation);

    expect(body).toContain('DEV-2026-0001');
    expect(body).toMatch(/15.?000 XAF/);
  });

  it('contient le libellé de statut du devis', () => {
    const body = renderQuotationSmsBody({ ...baseQuotation, status: 'COMPLETED' });
    expect(body).toContain('Converti en vente');
  });

  it('reste un texte court sans balise HTML', () => {
    const body = renderQuotationSmsBody(baseQuotation);
    expect(body).not.toMatch(/<[^>]+>/);
  });
});
