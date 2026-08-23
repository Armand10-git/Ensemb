import type { PaymentMethod, PaymentProvider } from '@prisma/client';

/**
 * Détails d'une confirmation de paiement rapportés par le webhook de l'agrégateur — jamais
 * saisis par le client, toujours issus du payload webhook après vérification de signature
 * (S31, §17 point V). Contrat partagé entre `PosService.confirmAsyncPayment` (POS) et
 * `SaleOnlinePaymentService.confirmPayment` (vente classique) pour que le contrôleur webhook
 * généralisé puisse appeler l'un ou l'autre de façon uniforme.
 */
export interface AggregatorPaymentConfirmation {
  /** Moyen réellement utilisé, rapporté par l'agrégateur (un seul compte agrégateur par organisation). */
  provider: PaymentProvider;
  providerCustomerId: string;
  providerTransactionId: string;
}

/**
 * Traduit le provider rapporté par l'agrégateur (CARD/ORANGE_MONEY/MTN_MOMO) vers le
 * `PaymentMethod` existant de `PaymentSale` (CASH/CARD/MOBILE_MONEY/BANK_TRANSFER, S20) —
 * Orange Money et MTN MoMo sont tous deux du "mobile money" au sens de cet enum, la
 * granularité du provider réel est conservée uniquement sur `PaymentWithCreditCard.provider`.
 */
export function mapProviderToPaymentMethod(provider: PaymentProvider): PaymentMethod {
  return provider === 'CARD' ? 'CARD' : 'MOBILE_MONEY';
}
