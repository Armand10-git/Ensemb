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

/**
 * Mêmes champs que CreatePaymentReturnSchema, tous optionnels — le solde restant est
 * recalculé côté service en excluant l'ancien montant de ce paiement (S26 — §18.5).
 * Ne contient jamais saleReturnId/purchaseReturnId : le parent d'un paiement existant
 * n'est jamais modifiable, il est déterminé depuis l'enregistrement en base.
 */
export const UpdatePaymentReturnSchema = z.object({
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }).optional(),
  amount: positiveDecimalString.optional(),
  method: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER'] as const).optional(),
  change: nonNegativeDecimalString.optional(),
  notes: z.string().max(500, 'La note ne peut pas dépasser 500 caractères').optional(),
});

export type UpdatePaymentReturnDto = z.infer<typeof UpdatePaymentReturnSchema>;
