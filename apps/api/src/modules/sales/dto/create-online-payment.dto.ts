import { z } from 'zod';

/** Initiation d'un paiement en ligne (agrégateur) sur une vente classique (S31, §17 point V). */
export const CreateOnlinePaymentSchema = z.object({
  /** Montant demandé — string décimale, jamais Float. Plafonné au solde restant côté service. */
  amount: z.string().min(1),
});

export type CreateOnlinePaymentDto = z.infer<typeof CreateOnlinePaymentSchema>;
