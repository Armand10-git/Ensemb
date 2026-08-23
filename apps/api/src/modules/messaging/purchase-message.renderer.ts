import type { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from './message-format.util';

/**
 * Ligne d'un achat pour le rendu email (S32).
 *
 * `productName` est optionnel car PurchaseService.findOne (apps/api/src/modules/purchases/purchase.service.ts)
 * ne renvoie que `productId`, pas le nom du produit — charger les noms est hors périmètre de
 * PurchaseService. C'est à l'appelant (purchase-email.worker.ts) de charger les noms séparément
 * et de les fournir ici ; à défaut, le rendu affiche l'identifiant du produit. Mirror exact de
 * SaleMessageLine (sale-message.renderer.ts).
 */
export interface PurchaseMessageLine {
  productId: string;
  productName?: string | null;
  quantity: Decimal;
  price: Decimal;
  total: Decimal;
}

/**
 * Sous-ensemble typé de PurchaseResponse nécessaire au rendu du récapitulatif email — mirror
 * exact de SaleMessageInput, `providerName` au lieu de `clientName`.
 */
export interface PurchaseMessageInput {
  reference: string;
  date: Date;
  paymentStatus: string;
  providerName?: string | null;
  grandTotal: Decimal;
  details: PurchaseMessageLine[];
}

/** Libellés français des statuts de paiement — mirror exact de sale-message.renderer.ts. */
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Non payé',
  PARTIAL: 'Partiellement payé',
  PAID: 'Payé',
};

/**
 * Traduit un statut de paiement en libellé français lisible ; retombe sur le code brut
 * si le statut est inconnu (défensif — ne doit jamais faire échouer le rendu).
 */
function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

/**
 * Construit le corps HTML du récapitulatif d'achat envoyé par email (S32). Mirror exact de
 * renderSaleEmailHtml — pas de framework de templating externe, toute donnée pouvant contenir
 * du texte libre (nom de fournisseur, nom de produit) est échappée via escapeHtml.
 *
 * @param purchase - Sous-ensemble de l'achat nécessaire au rendu (cf. PurchaseMessageInput).
 * @returns Une chaîne HTML autonome (pas de pièce jointe, pas de PDF — S32 exclut la génération PDF, S34).
 */
export function renderPurchaseEmailHtml(purchase: PurchaseMessageInput): string {
  const rows = purchase.details
    .map((line) => {
      const name = escapeHtml(line.productName ?? line.productId);
      return `
        <tr>
          <td>${name}</td>
          <td style="text-align:right">${line.quantity.toString()}</td>
          <td style="text-align:right">${formatAmount(line.price)}</td>
          <td style="text-align:right">${formatAmount(line.total)}</td>
        </tr>`;
    })
    .join('');

  const providerLine = purchase.providerName
    ? `<p>Fournisseur : ${escapeHtml(purchase.providerName)}</p>`
    : '';

  return `
    <div>
      <h2>Récapitulatif d'achat ${escapeHtml(purchase.reference)}</h2>
      <p>Date : ${formatDate(purchase.date)}</p>
      ${providerLine}
      <p>Statut de paiement : ${escapeHtml(paymentStatusLabel(purchase.paymentStatus))}</p>
      <table cellpadding="6" style="border-collapse:collapse;width:100%">
        <thead>
          <tr>
            <th style="text-align:left">Produit</th>
            <th style="text-align:right">Quantité</th>
            <th style="text-align:right">Prix unitaire</th>
            <th style="text-align:right">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p><strong>Total général : ${formatAmount(purchase.grandTotal)}</strong></p>
    </div>`;
}

/**
 * Construit le corps texte court du récapitulatif d'achat envoyé par SMS (S33) —
 * mirror exact de renderSaleSmsBody (sale-message.renderer.ts).
 *
 * @param purchase - Sous-ensemble de l'achat nécessaire au rendu (cf. PurchaseMessageInput).
 * @returns Un texte brut : référence, total et statut de paiement.
 */
export function renderPurchaseSmsBody(purchase: PurchaseMessageInput): string {
  return (
    `Achat ${purchase.reference} du ${formatDate(purchase.date)} — ` +
    `Total : ${formatAmount(purchase.grandTotal)} — ` +
    `Statut : ${paymentStatusLabel(purchase.paymentStatus)}.`
  );
}
