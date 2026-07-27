import { z } from 'zod';

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, strictement positif.
 * Ex. : "5", "10.500", "0.001" → valides ; "0", "-1" → rejetés par le raffinement.
 */
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Doit être un nombre décimal positif (ex. "5" ou "10.500")')
  .refine((v) => parseFloat(v) > 0, { message: 'Le montant doit être strictement positif.' });

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, non négatif.
 * Ex. : "0", "1500.500" → valides.
 */
const nonNegativeDecimalString = z
  .string()
  .regex(
    /^\d+(\.\d{1,3})?$/,
    'Doit être un nombre décimal non négatif (ex. "0" ou "1500.500")',
  );

/** Paiement encaissé sur une vente (S20 — §18.5). */
export const CreatePaymentSchema = z.object({
  /** Date de l'encaissement (ISO 8601). */
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }),

  /** Montant encaissé — string décimale, strictement positif. Plafonné au solde restant côté service. */
  amount: positiveDecimalString,

  /** Moyen de paiement. */
  method: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER'] as const),

  /** Monnaie rendue au client — string décimale, facultatif (défaut "0"). */
  change: nonNegativeDecimalString.optional(),

  /** Note libre, max 500 caractères. */
  notes: z.string().max(500, 'La note ne peut pas dépasser 500 caractères').optional(),
});

export type CreatePaymentDto = z.infer<typeof CreatePaymentSchema>;
