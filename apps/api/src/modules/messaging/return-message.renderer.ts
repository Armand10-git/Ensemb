import type { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from './message-format.util';

/**
 * Discriminant du sens du retour — détermine le vocabulaire affiché (« Client » vs
 * « Fournisseur », « retour de vente » vs « retour fournisseur »). Un SaleReturn a toujours
 * kind: 'sale', un PurchaseReturn a toujours kind: 'purchase' (S32).
 */
export type ReturnMessageKind = 'sale' | 'purchase';

/**
 * Ligne d'un retour pour le rendu email (S32) — mirror exact de SaleMessageLine.
 * `productName` chargé séparément par l'appelant (return-email.worker.ts), cf. patron établi
 * dans sale-email.worker.ts.
 */
export interface ReturnMessageLine {
  productId: string;
  productName?: string | null;
  quantity: Decimal;
  price: Decimal;
  total: Decimal;
}

/**
 * Sous-ensemble typé de SaleReturn/PurchaseReturn nécessaire au rendu du récapitulatif email
 * (S32) — couvre les deux sens via `kind` plutôt que deux renderers quasi identiques (mirrors
 * exacts en base, cf. schema.prisma). `counterpartyName` est le nom du client (retour de
 * vente) ou du fournisseur (retour d'achat) ; `originDocumentReference` est la référence de la
 * vente/de l'achat d'origine.
 */
export interface ReturnMessageInput {
  kind: ReturnMessageKind;
  reference: string;
  date: Date;
  status: string;
  originDocumentReference: string;
  counterpartyName?: string | null;
  grandTotal: Decimal;
  details: ReturnMessageLine[];
}

/** Libellés français des statuts de retour (DocumentStatus, schema.prisma). */
const RETURN_STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente de validation',
  AWAITING_PAYMENT: 'En attente de paiement',
  COMPLETED: 'Validé',
  CANCELLED: 'Annulé',
};

/**
 * Traduit un statut de retour en libellé français lisible ; retombe sur le code brut si
 * inconnu (défensif — ne doit jamais faire échouer le rendu).
 */
function returnStatusLabel(status: string): string {
  return RETURN_STATUS_LABELS[status] ?? status;
}

/**
 * Construit le corps HTML du récapitulatif de retour envoyé par email (S32) — couvre
 * SaleReturn (retour client) et PurchaseReturn (retour fournisseur) via `ret.kind`. Pas de
 * framework de templating externe, toute donnée pouvant contenir du texte libre (nom de
 * client/fournisseur, nom de produit) est échappée via escapeHtml.
 *
 * @param ret - Sous-ensemble du retour nécessaire au rendu (cf. ReturnMessageInput).
 * @returns Une chaîne HTML autonome (pas de pièce jointe, pas de PDF — S32 exclut la génération PDF, S34).
 */
export function renderReturnEmailHtml(ret: ReturnMessageInput): string {
  const isSale = ret.kind === 'sale';
  const title = isSale ? 'Récapitulatif de retour de vente' : 'Récapitulatif de retour fournisseur';
  const originLabel = isSale ? 'Vente' : 'Achat';
  const counterpartyLabel = isSale ? 'Client' : 'Fournisseur';

  const rows = ret.details
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

  const counterpartyLine = ret.counterpartyName
    ? `<p>${counterpartyLabel} : ${escapeHtml(ret.counterpartyName)}</p>`
    : '';

  return `
    <div>
      <h2>${title} ${escapeHtml(ret.reference)}</h2>
      <p>Date : ${formatDate(ret.date)}</p>
      <p>${originLabel} d'origine : ${escapeHtml(ret.originDocumentReference)}</p>
      ${counterpartyLine}
      <p>Statut : ${escapeHtml(returnStatusLabel(ret.status))}</p>
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
      <p><strong>Total général : ${formatAmount(ret.grandTotal)}</strong></p>
    </div>`;
}

/**
 * Construit le corps texte court du récapitulatif de retour envoyé par SMS (S33) —
 * mirror exact de renderSaleSmsBody (sale-message.renderer.ts).
 *
 * @param ret - Sous-ensemble du retour nécessaire au rendu (cf. ReturnMessageInput).
 * @returns Un texte brut : référence, total et statut du retour.
 */
export function renderReturnSmsBody(ret: ReturnMessageInput): string {
  const title = ret.kind === 'sale' ? 'Retour vente' : 'Retour fournisseur';
  return (
    `${title} ${ret.reference} du ${formatDate(ret.date)} — ` +
    `Total : ${formatAmount(ret.grandTotal)} — ` +
    `Statut : ${returnStatusLabel(ret.status)}.`
  );
}
