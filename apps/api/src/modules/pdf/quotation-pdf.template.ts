import { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from '../messaging/message-format.util';

/**
 * Ligne d'un devis pour le rendu PDF (S34) — mirror exact de QuotationMessageLine
 * (messaging/quotation-message.renderer.ts). `productName` est optionnel car
 * QuotationService.findOne (apps/api/src/modules/quotations/quotation.service.ts,
 * QuotationDetailResponse) ne renvoie que `productId` ; charger les noms est à la charge de
 * l'appelant (quotation-pdf.worker.ts), mirror du patron déjà établi pour l'email/SMS.
 */
export interface QuotationPdfLine {
  productId: string;
  productName?: string | null;
  quantity: Decimal;
  price: Decimal;
  total: Decimal;
}

/**
 * Sous-ensemble typé de QuotationResponse (apps/api/src/modules/quotations/quotation.service.ts)
 * nécessaire au rendu PDF — délibérément pas `QuotationResponse` complet : ce module ne doit
 * dépendre que des champs qu'il affiche réellement, pour rester testable avec de simples objets
 * factices sans construire un devis complet (mirror du choix déjà fait par SalePdfInput). Pas de
 * `paymentStatus` : un devis n'est jamais payé (§ contexte S28/S34).
 */
export interface QuotationPdfInput {
  reference: string;
  date: Date;
  status: string;
  clientName?: string | null;
  warehouseName?: string | null;
  discount: Decimal | null;
  taxAmount: Decimal | null;
  shipping: Decimal | null;
  grandTotal: Decimal;
  details: QuotationPdfLine[];
}

/** Libellés français des statuts de devis — mirror exact de QUOTATION_STATUS_LABELS (quotation-message.renderer.ts). */
const QUOTATION_STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente de validation',
  COMPLETED: 'Converti en vente',
  CANCELLED: 'Annulé',
};

/**
 * Traduit un statut de devis en libellé français lisible ; retombe sur le code brut si le
 * statut est inconnu (défensif — ne doit jamais faire échouer le rendu, mirror des renderers
 * messaging).
 */
function quotationStatusLabel(status: string): string {
  return QUOTATION_STATUS_LABELS[status] ?? status;
}

/**
 * Construit le contenu HTML (corps du document, pas de <html>/<head>/logo/titre — déjà rendus
 * par le wrapper wrapBrandedPdf, branded-pdf.template.ts) d'un devis pour export PDF (S34). Pas
 * de framework de templating externe — template strings simples, mirror du style d'écriture des
 * autres templates PDF (sale-pdf.template.ts). Toute donnée pouvant contenir du texte libre (nom
 * de client/entrepôt/produit) est échappée via escapeHtml avant insertion — un nom malveillant
 * ne doit jamais casser la mise en page ni injecter de balise.
 *
 * Le sous-total est recalculé en Decimal à partir des lignes (jamais Number/Float, §17 point 1)
 * plutôt que dérivé de grandTotal, pour rester correct même si remise/taxe/livraison ne sont
 * renseignées que partiellement.
 *
 * @param quotation - Sous-ensemble du devis nécessaire au rendu (cf. QuotationPdfInput).
 * @returns Le HTML du contenu du document, prêt à être passé en `contentHtml` à wrapBrandedPdf.
 */
export function renderQuotationPdfContent(quotation: QuotationPdfInput): string {
  const rows = quotation.details
    .map((line) => {
      const name = escapeHtml(line.productName ?? line.productId);
      return `
        <tr>
          <td>${name}</td>
          <td class="num">${line.quantity.toString()}</td>
          <td class="num">${formatAmount(line.price)}</td>
          <td class="num">${formatAmount(line.total)}</td>
        </tr>`;
    })
    .join('');

  const subtotal = quotation.details.reduce(
    (acc, d) => acc.plus(d.total),
    new Decimal(0),
  );

  const totalsRows = [
    `<tr><td>Sous-total</td><td>${formatAmount(subtotal)}</td></tr>`,
    quotation.discount && quotation.discount.gt(0)
      ? `<tr><td>Remise</td><td>${formatAmount(quotation.discount)}</td></tr>`
      : '',
    quotation.taxAmount && quotation.taxAmount.gt(0)
      ? `<tr><td>Taxe</td><td>${formatAmount(quotation.taxAmount)}</td></tr>`
      : '',
    quotation.shipping && quotation.shipping.gt(0)
      ? `<tr><td>Livraison</td><td>${formatAmount(quotation.shipping)}</td></tr>`
      : '',
    `<tr class="grand-total"><td>Total général</td><td>${formatAmount(quotation.grandTotal)}</td></tr>`,
  ].join('');

  return `
    <div class="meta">
      <p>Référence : ${escapeHtml(quotation.reference)}</p>
      <p>Date : ${formatDate(quotation.date)}</p>
      <p>Client : ${quotation.clientName ? escapeHtml(quotation.clientName) : '—'}</p>
      <p>Entrepôt : ${quotation.warehouseName ? escapeHtml(quotation.warehouseName) : '—'}</p>
      <p>Statut du devis : ${escapeHtml(quotationStatusLabel(quotation.status))}</p>
    </div>
    <table>
      <thead>
        <tr>
          <th>Produit</th>
          <th class="num">Quantité</th>
          <th class="num">Prix unitaire</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="totals">
      <tbody>${totalsRows}</tbody>
    </table>`;
}
