import { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from '../messaging/message-format.util';

/**
 * Ligne d'une vente pour le rendu PDF (S34) — mirror exact de SaleMessageLine
 * (messaging/sale-message.renderer.ts). `productName` est optionnel car SaleService.findOne
 * (apps/api/src/modules/sales/sale.service.ts, SaleDetailResponse) ne renvoie que `productId` ;
 * charger les noms est à la charge de l'appelant (sale-pdf.worker.ts), mirror du patron déjà
 * établi pour l'email/SMS.
 */
export interface SalePdfLine {
  productId: string;
  productName?: string | null;
  quantity: Decimal;
  price: Decimal;
  total: Decimal;
}

/**
 * Sous-ensemble typé de SaleResponse (apps/api/src/modules/sales/sale.service.ts) nécessaire
 * au rendu PDF — délibérément pas `SaleResponse` complet : ce module ne doit dépendre que des
 * champs qu'il affiche réellement, pour rester testable avec de simples objets factices sans
 * construire une vente complète (mirror du choix déjà fait par SaleMessageInput).
 */
export interface SalePdfInput {
  reference: string;
  date: Date;
  status: string;
  paymentStatus: string;
  clientName?: string | null;
  warehouseName?: string | null;
  discount: Decimal | null;
  taxAmount: Decimal | null;
  shipping: Decimal | null;
  grandTotal: Decimal;
  details: SalePdfLine[];
}

/** Libellés français des statuts de document (DocumentStatus, schema.prisma) — accord féminin ("la vente"). */
const SALE_STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente de validation',
  AWAITING_PAYMENT: 'En attente de paiement',
  COMPLETED: 'Validée',
  CANCELLED: 'Annulée',
};

/** Libellés français des statuts de paiement — mirror exact de sale-message.renderer.ts. */
const SALE_PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Non payée',
  PARTIAL: 'Partiellement payée',
  PAID: 'Payée',
};

/**
 * Traduit un statut de document en libellé français lisible ; retombe sur le code brut si
 * inconnu (défensif — ne doit jamais faire échouer le rendu, mirror des renderers messaging).
 */
function saleStatusLabel(status: string): string {
  return SALE_STATUS_LABELS[status] ?? status;
}

/**
 * Traduit un statut de paiement en libellé français lisible ; retombe sur le code brut si
 * inconnu (défensif, mirror de paymentStatusLabel dans sale-message.renderer.ts).
 */
function salePaymentStatusLabel(status: string): string {
  return SALE_PAYMENT_STATUS_LABELS[status] ?? status;
}

/**
 * Construit le contenu HTML (corps du document, pas de <html>/<head>/logo/titre — déjà rendus
 * par le wrapper wrapBrandedPdf, branded-pdf.template.ts) d'une facture de vente pour export PDF
 * (S34). Pas de framework de templating externe — template strings simples, mirror du style
 * d'écriture des renderers email (messaging/sale-message.renderer.ts). Toute donnée pouvant
 * contenir du texte libre (nom de client/entrepôt/produit) est échappée via escapeHtml avant
 * insertion — un nom malveillant ne doit jamais casser la mise en page ni injecter de balise.
 *
 * Le sous-total est recalculé en Decimal à partir des lignes (jamais Number/Float, §17 point 1)
 * plutôt que dérivé de grandTotal, pour rester correct même si remise/taxe/livraison ne sont
 * renseignées que partiellement.
 *
 * @param sale - Sous-ensemble de la vente nécessaire au rendu (cf. SalePdfInput).
 * @returns Le HTML du contenu du document, prêt à être passé en `contentHtml` à wrapBrandedPdf.
 */
export function renderSalePdfContent(sale: SalePdfInput): string {
  const rows = sale.details
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

  const subtotal = sale.details.reduce(
    (acc, d) => acc.plus(d.total),
    new Decimal(0),
  );

  const totalsRows = [
    `<tr><td>Sous-total</td><td>${formatAmount(subtotal)}</td></tr>`,
    sale.discount && sale.discount.gt(0)
      ? `<tr><td>Remise</td><td>${formatAmount(sale.discount)}</td></tr>`
      : '',
    sale.taxAmount && sale.taxAmount.gt(0)
      ? `<tr><td>Taxe</td><td>${formatAmount(sale.taxAmount)}</td></tr>`
      : '',
    sale.shipping && sale.shipping.gt(0)
      ? `<tr><td>Livraison</td><td>${formatAmount(sale.shipping)}</td></tr>`
      : '',
    `<tr class="grand-total"><td>Total général</td><td>${formatAmount(sale.grandTotal)}</td></tr>`,
  ].join('');

  return `
    <div class="meta">
      <p>Référence : ${escapeHtml(sale.reference)}</p>
      <p>Date : ${formatDate(sale.date)}</p>
      <p>Client : ${sale.clientName ? escapeHtml(sale.clientName) : '—'}</p>
      <p>Entrepôt : ${sale.warehouseName ? escapeHtml(sale.warehouseName) : '—'}</p>
      <p>Statut : ${escapeHtml(saleStatusLabel(sale.status))}</p>
      <p>Statut de paiement : ${escapeHtml(salePaymentStatusLabel(sale.paymentStatus))}</p>
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
