import { z } from 'zod';

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, strictement positif.
 * Ex. : "5", "10.500", "0.001" → valides ; "0", "-1" → rejetés par le raffinement.
 */
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Doit être un nombre décimal positif (ex. "5" ou "10.500")')
  .refine((v) => parseFloat(v) > 0, { message: 'La quantité doit être strictement positive.' });

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

/** Ligne d'un ajustement de stock. */
export const AdjustmentDetailSchema = z.object({
  /** UUID du produit concerné. Vérifié côté service (ownership org). */
  productId: z.string().uuid('productId doit être un UUID valide'),

  /** UUID de la variante — optionnel. */
  productVariantId: z.string().uuid('productVariantId doit être un UUID valide').optional(),

  /** Sens du mouvement : ADDITION augmente le stock, SOUSTRACTION le diminue. */
  type: z.enum(['ADDITION', 'SOUSTRACTION'] as const, {
    message: "type doit être 'ADDITION' ou 'SOUSTRACTION'",
  }),

  /** Quantité ajustée — string décimale convertie en Decimal dans le service. Toujours > 0. */
  quantity: positiveDecimalString,

  /** Coût unitaire pour valorisation — string décimale, facultatif (défaut 0). */
  unitCost: nonNegativeDecimalString.optional(),
});

export const CreateAdjustmentSchema = z.object({
  /** UUID de l'entrepôt concerné — vérifié côté service (ownership org). */
  warehouseId: z.string().uuid('warehouseId doit être un UUID valide'),

  /** Date de l'ajustement (ISO 8601). */
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }),

  /** Note libre, max 500 caractères. */
  note: z.string().max(500, 'La note ne peut pas dépasser 500 caractères').optional(),

  /** Lignes de l'ajustement — au moins une ligne requise. */
  details: z
    .array(AdjustmentDetailSchema)
    .min(1, "L'ajustement doit comporter au moins une ligne"),
});

export type CreateAdjustmentDto = z.infer<typeof CreateAdjustmentSchema>;
export type AdjustmentDetailDto = z.infer<typeof AdjustmentDetailSchema>;
