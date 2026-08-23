import type { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from './message-format.util';

/**
 * Ligne d'une vente pour le rendu email/SMS (S24).
 *
 * `productName` est optionnel car SaleService.findOne (apps/api/src/modules/sales/sale.service.ts,
 * SaleDetailResponse) ne renvoie que `productId`, pas le nom du produit — charger les noms
 * est hors périmètre de SaleService (qui reste focalisé sur les données de facturation).
 * C'est à l'appelant (le worker sale-email.worker.ts / sale-sms.worker.ts) de charger les
 * noms séparément (ex. ProductService ou PrismaService.product.findMany) et de les fournir
 * ici ; à défaut, le rendu affiche l'identifiant du produit.
 */
export interface SaleMessageLine {
  productId: string;
  productName?: string | null;
  quantity: Decimal;
  price: Decimal;
  total: Decimal;
}

/**
 * Sous-ensemble typé de SaleResponse (apps/api/src/modules/sales/sale.service.ts) nécessaire
 * au rendu du récapitulatif email/SMS — délibérément pas `SaleResponse` complet : ce module
 * ne doit dépendre que des champs qu'il affiche réellement, pour rester testable avec de
 * simples objets factices sans construire une vente complète.
 */
export interface SaleMessageInput {
  reference: string;
  date: Date;
  paymentStatus: string;
  clientName?: string | null;
  grandTotal: Decimal;
  details: SaleMessageLine[];
}

/** Libellés français des statuts de paiement (§ vocabulaire continu, docs/ux/standards.md). */
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Non payée',
  PARTIAL: 'Partiellement payée',
  PAID: 'Payée',
};

/**
 * Traduit un statut de paiement en libellé français lisible ; retombe sur le code brut
 * si le statut est inconnu (défensif — ne doit jamais faire échouer le rendu).
 */
function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

/**
 * Construit le corps HTML du récapitulatif de vente envoyé par email (S24).
 * Pas de framework de templating externe — template strings simples. Toute donnée
 * pouvant contenir du texte libre (nom de client, nom de produit) est échappée via
 * escapeHtml avant insertion.
 *
 * @param sale - Sous-ensemble de la vente nécessaire au rendu (cf. SaleMessageInput).
 * @returns Une chaîne HTML autonome (pas de pièce jointe, pas de PDF — S24).
 */
export function renderSaleEmailHtml(sale: SaleMessageInput): string {
  const rows = sale.details
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

  const clientLine = sale.clientName
    ? `<p>Client : ${escapeHtml(sale.clientName)}</p>`
    : '';

  return `
    <div>
      <h2>Récapitulatif de vente ${escapeHtml(sale.reference)}</h2>
      <p>Date : ${formatDate(sale.date)}</p>
      ${clientLine}
      <p>Statut de paiement : ${escapeHtml(paymentStatusLabel(sale.paymentStatus))}</p>
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
      <p><strong>Total général : ${formatAmount(sale.grandTotal)}</strong></p>
    </div>`;
}

/**
 * Construit le corps texte court du récapitulatif de vente envoyé par SMS (S24) —
 * pas de mise en forme HTML, format compact adapté à la longueur d'un SMS.
 *
 * @param sale - Sous-ensemble de la vente nécessaire au rendu (cf. SaleMessageInput).
 * @returns Un texte brut : référence, total et statut de paiement.
 */
export function renderSaleSmsBody(sale: SaleMessageInput): string {
  return (
    `Vente ${sale.reference} du ${formatDate(sale.date)} — ` +
    `Total : ${formatAmount(sale.grandTotal)} — ` +
    `Statut : ${paymentStatusLabel(sale.paymentStatus)}.`
  );
}
