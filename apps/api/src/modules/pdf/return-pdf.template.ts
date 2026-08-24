import { Decimal } from '@prisma/client/runtime/library';
import { escapeHtml, formatAmount, formatDate } from '../messaging/message-format.util';

/**
 * Discriminant du sens du retour — détermine le vocabulaire affiché (« Client » vs
 * « Fournisseur », « Vente » vs « Achat » d'origine). Un SaleReturn a toujours kind: 'sale', un
 * PurchaseReturn a toujours kind: 'purchase' (mirror exact de ReturnMessageKind,
 * messaging/return-message.renderer.ts).
 */
export type ReturnPdfKind = 'sale' | 'purchase';

/**
 * Ligne d'un retour pour le rendu PDF (S34) — mirror exact de ReturnMessageLine
 * (messaging/return-message.renderer.ts). `productName` est optionnel car ni
 * SaleReturnService.findOne ni PurchaseReturnService.findOne ne renvoient le nom du produit ;
 * charger les noms est à la charge de l'appelant (return-pdf.worker.ts), mirror du patron déjà
 * établi pour l'email/SMS.
 */
export interface ReturnPdfLine {
  productId: string;
  productName?: string | null;
  quantity: Decimal;
  price: Decimal;
  total: Decimal;
}

/**
 * Sous-ensemble typé de SaleReturnResponse/PurchaseReturnResponse
 * (apps/api/src/modules/returns/) nécessaire au rendu PDF — couvre les deux sens via `kind`
 * plutôt que deux templates quasi identiques (mirrors exacts en base, cf. schema.prisma).
 * `counterpartyName` est le nom du client (retour de vente) ou du fournisseur (retour d'achat) ;
 * `originDocumentReference` est la référence de la vente/de l'achat d'origine. Ni l'un ni
 * l'autre service ne les expose — c'est à l'appelant de les résoudre séparément (mirror exact du
 * patron établi par return-email.worker.ts : requête PrismaService supplémentaire sur
 * Sale.client / Purchase.provider).
 */
export interface ReturnPdfInput {
  kind: ReturnPdfKind;
  reference: string;
  date: Date;
  status: string;
  paymentStatus: string;
  originDocumentReference: string;
  counterpartyName?: string | null;
  warehouseName?: string | null;
  discount: Decimal | null;
  taxAmount: Decimal | null;
  shipping: Decimal | null;
  grandTotal: Decimal;
  details: ReturnPdfLine[];
}

/** Libellés français des statuts de retour — mirror exact de RETURN_STATUS_LABELS (return-message.renderer.ts). */
const RETURN_STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente de validation',
  AWAITING_PAYMENT: 'En attente de paiement',
  COMPLETED: 'Validé',
  CANCELLED: 'Annulé',
};

/** Libellés français des statuts de paiement d'un retour — accord masculin ("le retour"), mirror de purchase-message.renderer.ts. */
const RETURN_PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Non payé',
  PARTIAL: 'Partiellement payé',
  PAID: 'Payé',
};

/**
 * Traduit un statut de retour en libellé français lisible ; retombe sur le code brut si inconnu
 * (défensif — ne doit jamais faire échouer le rendu, mirror des renderers messaging).
 */
function returnStatusLabel(status: string): string {
  return RETURN_STATUS_LABELS[status] ?? status;
}

/**
 * Traduit un statut de paiement de retour en libellé français lisible ; retombe sur le code brut
 * si inconnu (défensif, mirror de salePaymentStatusLabel dans sale-pdf.template.ts).
 */
function returnPaymentStatusLabel(status: string): string {
  return RETURN_PAYMENT_STATUS_LABELS[status] ?? status;
}

/**
 * Construit le contenu HTML (corps du document, pas de <html>/<head>/logo/titre — déjà rendus
 * par le wrapper wrapBrandedPdf, branded-pdf.template.ts) d'un retour (de vente ou fournisseur)
 * pour export PDF (S34) — couvre SaleReturn et PurchaseReturn via `ret.kind`, un seul template
 * plutôt que deux quasi identiques (mirror du choix déjà fait par renderReturnEmailHtml,
 * messaging/return-message.renderer.ts). Pas de framework de templating externe — template
 * strings simples. Toute donnée pouvant contenir du texte libre (nom de client/fournisseur/
 * entrepôt/produit) est échappée via escapeHtml avant insertion — un nom malveillant ne doit
 * jamais casser la mise en page ni injecter de balise.
 *
 * Le sous-total est recalculé en Decimal à partir des lignes (jamais Number/Float, §17 point 1)
 * plutôt que dérivé de grandTotal, pour rester correct même si remise/taxe/livraison ne sont
 * renseignées que partiellement.
 *
 * @param ret - Sous-ensemble du retour nécessaire au rendu (cf. ReturnPdfInput).
 * @returns Le HTML du contenu du document, prêt à être passé en `contentHtml` à wrapBrandedPdf.
 */
export function renderReturnPdfContent(ret: ReturnPdfInput): string {
  const isSale = ret.kind === 'sale';
  const originLabel = isSale ? 'Vente' : 'Achat';
  const counterpartyLabel = isSale ? 'Client' : 'Fournisseur';

  const rows = ret.details
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

  const subtotal = ret.details.reduce(
    (acc, d) => acc.plus(d.total),
    new Decimal(0),
  );

  const totalsRows = [
    `<tr><td>Sous-total</td><td>${formatAmount(subtotal)}</td></tr>`,
    ret.discount && ret.discount.gt(0)
      ? `<tr><td>Remise</td><td>${formatAmount(ret.discount)}</td></tr>`
      : '',
    ret.taxAmount && ret.taxAmount.gt(0)
      ? `<tr><td>Taxe</td><td>${formatAmount(ret.taxAmount)}</td></tr>`
      : '',
    ret.shipping && ret.shipping.gt(0)
      ? `<tr><td>Livraison</td><td>${formatAmount(ret.shipping)}</td></tr>`
      : '',
    `<tr class="grand-total"><td>Total général</td><td>${formatAmount(ret.grandTotal)}</td></tr>`,
  ].join('');

  return `
    <div class="meta">
      <p>Référence : ${escapeHtml(ret.reference)}</p>
      <p>Date : ${formatDate(ret.date)}</p>
      <p>${originLabel} d'origine : ${escapeHtml(ret.originDocumentReference)}</p>
      <p>${counterpartyLabel} : ${ret.counterpartyName ? escapeHtml(ret.counterpartyName) : '—'}</p>
      <p>Entrepôt : ${ret.warehouseName ? escapeHtml(ret.warehouseName) : '—'}</p>
      <p>Statut : ${escapeHtml(returnStatusLabel(ret.status))}</p>
      <p>Statut de paiement : ${escapeHtml(returnPaymentStatusLabel(ret.paymentStatus))}</p>
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
