import type { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from './message-format.util';

/**
 * Ligne d'un devis pour le rendu email/SMS (S28).
 *
 * `productName` est optionnel car QuotationService.findOne (apps/api/src/modules/quotations/quotation.service.ts,
 * QuotationDetailResponse) ne renvoie que `productId`, pas le nom du produit — charger les noms
 * est hors périmètre de QuotationService (qui reste focalisé sur les données de devis).
 * C'est à l'appelant (le worker quotation-email.worker.ts / quotation-sms.worker.ts) de charger
 * les noms séparément (ex. ProductService ou PrismaService.product.findMany) et de les fournir
 * ici ; à défaut, le rendu affiche l'identifiant du produit.
 */
export interface QuotationMessageLine {
  productId: string;
  productName?: string | null;
  quantity: Decimal;
  price: Decimal;
  total: Decimal;
}

/**
 * Sous-ensemble typé de QuotationResponse (apps/api/src/modules/quotations/quotation.service.ts)
 * nécessaire au rendu du récapitulatif email/SMS — délibérément pas `QuotationResponse` complet :
 * ce module ne doit dépendre que des champs qu'il affiche réellement, pour rester testable avec
 * de simples objets factices sans construire un devis complet.
 *
 * Contrairement à SaleMessageInput, pas de `paymentStatus` : un devis n'est jamais payé (§ contexte
 * S28) — c'est `status` (DocumentStatus : PENDING/COMPLETED/CANCELLED en pratique pour un devis)
 * qui est affiché, traduit en libellé de statut de devis (cf. QUOTATION_STATUS_LABELS).
 */
export interface QuotationMessageInput {
  reference: string;
  date: Date;
  status: string;
  clientName?: string | null;
  grandTotal: Decimal;
  details: QuotationMessageLine[];
}

/** Libellés français des statuts de devis (§ vocabulaire continu, docs/ux/standards.md). */
const QUOTATION_STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente de validation',
  COMPLETED: 'Converti en vente',
  CANCELLED: 'Annulé',
};

/**
 * Traduit un statut de devis en libellé français lisible ; retombe sur le code brut
 * si le statut est inconnu (défensif — ne doit jamais faire échouer le rendu).
 */
function quotationStatusLabel(status: string): string {
  return QUOTATION_STATUS_LABELS[status] ?? status;
}

/**
 * Construit le corps HTML du récapitulatif de devis envoyé par email (S28).
 * Pas de framework de templating externe — template strings simples. Toute donnée
 * pouvant contenir du texte libre (nom de client, nom de produit) est échappée via
 * escapeHtml avant insertion.
 *
 * @param quotation - Sous-ensemble du devis nécessaire au rendu (cf. QuotationMessageInput).
 * @returns Une chaîne HTML autonome (pas de pièce jointe, pas de PDF — S28).
 */
export function renderQuotationEmailHtml(quotation: QuotationMessageInput): string {
  const rows = quotation.details
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

  const clientLine = quotation.clientName
    ? `<p>Client : ${escapeHtml(quotation.clientName)}</p>`
    : '';

  return `
    <div>
      <h2>Récapitulatif de devis ${escapeHtml(quotation.reference)}</h2>
      <p>Date : ${formatDate(quotation.date)}</p>
      ${clientLine}
      <p>Statut du devis : ${escapeHtml(quotationStatusLabel(quotation.status))}</p>
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
      <p><strong>Total général : ${formatAmount(quotation.grandTotal)}</strong></p>
    </div>`;
}

/**
 * Construit le corps texte court du récapitulatif de devis envoyé par SMS (S28) —
 * pas de mise en forme HTML, format compact adapté à la longueur d'un SMS.
 *
 * @param quotation - Sous-ensemble du devis nécessaire au rendu (cf. QuotationMessageInput).
 * @returns Un texte brut : référence, total et statut du devis.
 */
export function renderQuotationSmsBody(quotation: QuotationMessageInput): string {
  return (
    `Devis ${quotation.reference} du ${formatDate(quotation.date)} — ` +
    `Total : ${formatAmount(quotation.grandTotal)} — ` +
    `Statut : ${quotationStatusLabel(quotation.status)}.`
  );
}
