import { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from '../messaging/message-format.util';

/**
 * Ligne d'un achat pour le rendu PDF (S34) — mirror exact de SalePdfLine (sale-pdf.template.ts).
 * `productName` est optionnel car PurchaseService.findOne (apps/api/src/modules/purchases/
 * purchase.service.ts, PurchaseDetailResponse) ne renvoie que `productId` ; charger les noms est
 * à la charge de l'appelant (purchase-pdf.worker.ts), mirror du patron établi pour l'email/SMS.
 */
export interface PurchasePdfLine {
  productId: string;
  productName?: string | null;
  quantity: Decimal;
  price: Decimal;
  total: Decimal;
}

/**
 * Sous-ensemble typé de PurchaseResponse (apps/api/src/modules/purchases/purchase.service.ts)
 * nécessaire au rendu PDF — mirror exact de SalePdfInput, `providerName` au lieu de `clientName`.
 */
export interface PurchasePdfInput {
  reference: string;
  date: Date;
  status: string;
  paymentStatus: string;
  providerName?: string | null;
  warehouseName?: string | null;
  discount: Decimal | null;
  taxAmount: Decimal | null;
  shipping: Decimal | null;
  grandTotal: Decimal;
  details: PurchasePdfLine[];
}

/** Libellés français des statuts de document (DocumentStatus, schema.prisma) — accord masculin ("l'achat"). */
const PURCHASE_STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente de validation',
  AWAITING_PAYMENT: 'En attente de paiement',
  COMPLETED: 'Validé',
  CANCELLED: 'Annulé',
};

/** Libellés français des statuts de paiement — mirror exact de purchase-message.renderer.ts. */
const PURCHASE_PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Non payé',
  PARTIAL: 'Partiellement payé',
  PAID: 'Payé',
};

/**
 * Traduit un statut de document en libellé français lisible ; retombe sur le code brut si
 * inconnu (défensif — ne doit jamais faire échouer le rendu, mirror des renderers messaging).
 */
function purchaseStatusLabel(status: string): string {
  return PURCHASE_STATUS_LABELS[status] ?? status;
}

/**
 * Traduit un statut de paiement en libellé français lisible ; retombe sur le code brut si
 * inconnu (défensif, mirror de paymentStatusLabel dans purchase-message.renderer.ts).
 */
function purchasePaymentStatusLabel(status: string): string {
  return PURCHASE_PAYMENT_STATUS_LABELS[status] ?? status;
}

/**
 * Construit le contenu HTML (corps du document, pas de <html>/<head>/logo/titre — déjà rendus
 * par le wrapper wrapBrandedPdf, branded-pdf.template.ts) d'un bon d'achat pour export PDF
 * (S34). Mirror exact de renderSalePdfContent — pas de framework de templating externe, toute
 * donnée pouvant contenir du texte libre (nom de fournisseur/entrepôt/produit) est échappée via
 * escapeHtml avant insertion — un nom malveillant ne doit jamais casser la mise en page ni
 * injecter de balise.
 *
 * Le sous-total est recalculé en Decimal à partir des lignes (jamais Number/Float, §17 point 1)
 * plutôt que dérivé de grandTotal, pour rester correct même si remise/taxe/livraison ne sont
 * renseignées que partiellement.
 *
 * @param purchase - Sous-ensemble de l'achat nécessaire au rendu (cf. PurchasePdfInput).
 * @returns Le HTML du contenu du document, prêt à être passé en `contentHtml` à wrapBrandedPdf.
 */
export function renderPurchasePdfContent(purchase: PurchasePdfInput): string {
  const rows = purchase.details
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

  const subtotal = purchase.details.reduce(
    (acc, d) => acc.plus(d.total),
    new Decimal(0),
  );

  const totalsRows = [
    `<tr><td>Sous-total</td><td>${formatAmount(subtotal)}</td></tr>`,
    purchase.discount && purchase.discount.gt(0)
      ? `<tr><td>Remise</td><td>${formatAmount(purchase.discount)}</td></tr>`
      : '',
    purchase.taxAmount && purchase.taxAmount.gt(0)
      ? `<tr><td>Taxe</td><td>${formatAmount(purchase.taxAmount)}</td></tr>`
      : '',
    purchase.shipping && purchase.shipping.gt(0)
      ? `<tr><td>Livraison</td><td>${formatAmount(purchase.shipping)}</td></tr>`
      : '',
    `<tr class="grand-total"><td>Total général</td><td>${formatAmount(purchase.grandTotal)}</td></tr>`,
  ].join('');

  return `
    <div class="meta">
      <p>Référence : ${escapeHtml(purchase.reference)}</p>
      <p>Date : ${formatDate(purchase.date)}</p>
      <p>Fournisseur : ${purchase.providerName ? escapeHtml(purchase.providerName) : '—'}</p>
      <p>Entrepôt : ${purchase.warehouseName ? escapeHtml(purchase.warehouseName) : '—'}</p>
      <p>Statut : ${escapeHtml(purchaseStatusLabel(purchase.status))}</p>
      <p>Statut de paiement : ${escapeHtml(purchasePaymentStatusLabel(purchase.paymentStatus))}</p>
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
