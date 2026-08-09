import { z } from 'zod';

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, non négatif.
 * Ex. : "0", "1500.500" → valides. Mirror exact de create-sale.dto.ts.
 */
const nonNegativeDecimalString = z
  .string()
  .regex(
    /^\d+(\.\d{1,3})?$/,
    'Doit être un nombre décimal non négatif (ex. "0" ou "1500.500")',
  );

/** Schéma de création d'une dépense (S29) — entité plate, pas de lignes de détail. */
export const CreateExpenseSchema = z.object({
  /** Date de la dépense (ISO 8601). */
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }),

  /** UUID de la catégorie de dépense — vérifié côté service (ownership org). */
  expenseCategoryId: z.string().uuid('expenseCategoryId doit être un UUID valide'),

  /** UUID de l'entrepôt — vérifié côté service (ownership org). */
  warehouseId: z.string().uuid('warehouseId doit être un UUID valide'),

  /** Libellé / description libre de la dépense — obligatoire, non-vide. */
  details: z
    .string()
    .min(1, 'Les détails de la dépense sont obligatoires')
    .max(1000, 'Les détails ne peuvent pas dépasser 1000 caractères'),

  /** Montant de la dépense — string décimale, non négatif. */
  amount: nonNegativeDecimalString,
});

export const UpdateExpenseSchema = CreateExpenseSchema.partial();

export type CreateExpenseDto = z.infer<typeof CreateExpenseSchema>;
export type UpdateExpenseDto = z.infer<typeof UpdateExpenseSchema>;
