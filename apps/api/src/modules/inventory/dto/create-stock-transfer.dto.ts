import { z } from 'zod';

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, strictement positif.
 * Ex. : "5", "10.500", "0.001" → valides ; "0", "-1" → rejetés par le raffinement.
 */
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Doit être un nombre décimal positif (ex. "5" ou "10.500")')
  .refine((v) => parseFloat(v) > 0, { message: 'La quantité doit être strictement positive.' });

/** Ligne d'un transfert de stock. */
export const StockTransferDetailSchema = z.object({
  /** UUID du produit transféré. Vérifié côté service (ownership org). */
  productId: z.string().uuid('productId doit être un UUID valide'),

  /** UUID de la variante — optionnel. */
  productVariantId: z.string().uuid('productVariantId doit être un UUID valide').optional(),

  /** Quantité transférée — string décimale convertie en Decimal dans le service. Toujours > 0. */
  quantity: positiveDecimalString,
});

export const CreateStockTransferSchema = z.object({
  /** UUID de l'entrepôt source — vérifié côté service (ownership org, ≠ toWarehouseId). */
  fromWarehouseId: z.string().uuid('fromWarehouseId doit être un UUID valide'),

  /** UUID de l'entrepôt destination — vérifié côté service (ownership org, ≠ fromWarehouseId). */
  toWarehouseId: z.string().uuid('toWarehouseId doit être un UUID valide'),

  /** Date du transfert (ISO 8601). */
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }),

  /** Note libre, max 500 caractères. */
  note: z.string().max(500, 'La note ne peut pas dépasser 500 caractères').optional(),

  /** Lignes du transfert — au moins une ligne requise. */
  details: z
    .array(StockTransferDetailSchema)
    .min(1, 'Le transfert doit comporter au moins une ligne'),
});

export type CreateStockTransferDto = z.infer<typeof CreateStockTransferSchema>;
export type StockTransferDetailDto = z.infer<typeof StockTransferDetailSchema>;
