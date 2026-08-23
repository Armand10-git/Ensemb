import type { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from './message-format.util';

/**
 * Discriminant du document parent d'un paiement — détermine le vocabulaire affiché
 * (« Client » vs « Fournisseur », « vente » vs « achat »). Un PaymentSale a toujours
 * kind: 'sale', un PaymentPurchase a toujours kind: 'purchase' (S32).
 */
export type PaymentReceiptKind = 'sale' | 'purchase';

/**
 * Sous-ensemble typé de PaymentSale/PaymentPurchase nécessaire au rendu du reçu de paiement
 * par email (S32) — couvre les deux types via `kind` plutôt que deux renderers quasi
 * identiques (PaymentSale et PaymentPurchase sont des mirrors exacts en base, cf.
 * schema.prisma). `counterpartyName` est le nom du client (vente) ou du fournisseur (achat).
 */
export interface PaymentReceiptMessageInput {
  kind: PaymentReceiptKind;
  reference: string;
  date: Date;
  amount: Decimal;
  method: string;
  change?: Decimal | null;
  /** Référence du document d'origine (Sale.reference ou Purchase.reference). */
  documentReference: string;
  counterpartyName?: string | null;
}

/** Libellés français des moyens de paiement (PaymentMethod, schema.prisma). */
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Espèces',
  CARD: 'Carte bancaire',
  MOBILE_MONEY: 'Mobile Money',
  BANK_TRANSFER: 'Virement bancaire',
};

/**
 * Traduit un moyen de paiement en libellé français lisible ; retombe sur le code brut si
 * inconnu (défensif — ne doit jamais faire échouer le rendu).
 */
function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

/**
 * Construit le corps HTML du reçu de paiement envoyé par email (S32) — couvre PaymentSale
 * (encaissement d'une vente) et PaymentPurchase (règlement d'un achat fournisseur) via
 * `receipt.kind`. Pas de framework de templating externe, toute donnée pouvant contenir du
 * texte libre (nom de client/fournisseur) est échappée via escapeHtml.
 *
 * @param receipt - Sous-ensemble du paiement nécessaire au rendu (cf. PaymentReceiptMessageInput).
 * @returns Une chaîne HTML autonome (pas de pièce jointe, pas de PDF — S32 exclut la génération PDF, S34).
 */
export function renderPaymentReceiptEmailHtml(receipt: PaymentReceiptMessageInput): string {
  const isSale = receipt.kind === 'sale';
  const documentLabel = isSale ? 'vente' : 'achat';
  const counterpartyLabel = isSale ? 'Client' : 'Fournisseur';

  const counterpartyLine = receipt.counterpartyName
    ? `<p>${counterpartyLabel} : ${escapeHtml(receipt.counterpartyName)}</p>`
    : '';

  const changeLine =
    receipt.change && !receipt.change.isZero()
      ? `<p>Monnaie rendue : ${formatAmount(receipt.change)}</p>`
      : '';

  return `
    <div>
      <h2>Reçu de paiement ${escapeHtml(receipt.reference)}</h2>
      <p>Date : ${formatDate(receipt.date)}</p>
      <p>Document d'origine (${documentLabel}) : ${escapeHtml(receipt.documentReference)}</p>
      ${counterpartyLine}
      <p>Moyen de paiement : ${escapeHtml(paymentMethodLabel(receipt.method))}</p>
      <p><strong>Montant réglé : ${formatAmount(receipt.amount)}</strong></p>
      ${changeLine}
    </div>`;
}
