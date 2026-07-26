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

/** Ligne d'une vente classique. */
export const SaleDetailSchema = z.object({
  /** UUID du produit vendu. Vérifié côté service (ownership org). */
  productId: z.string().uuid('productId doit être un UUID valide'),

  /** UUID de la variante — optionnel. */
  productVariantId: z.string().uuid('productVariantId doit être un UUID valide').optional(),

  /** UUID de l'unité de vente choisie pour cette ligne — optionnel. */
  saleUnitId: z.string().uuid('saleUnitId doit être un UUID valide').optional(),

  /** Prix unitaire — string décimale, non négatif. */
  price: nonNegativeDecimalString,

  /** Quantité vendue — string décimale convertie en Decimal dans le service. Toujours > 0. */
  quantity: positiveDecimalString,

  /** Taxe de ligne — string décimale, facultatif (défaut "0"). */
  taxAmount: nonNegativeDecimalString.optional(),

  /** "percentage" | "fixed" — facultatif (défaut "percentage"). */
  taxMethod: z.enum(['percentage', 'fixed'] as const).optional(),

  /** Remise de ligne — string décimale, facultatif (défaut "0"). */
  discount: nonNegativeDecimalString.optional(),

  /** "percentage" | "fixed" — facultatif (défaut "percentage"). */
  discountMethod: z.enum(['percentage', 'fixed'] as const).optional(),
});

export const CreateSaleSchema = z.object({
  /** UUID du client — vérifié côté service (ownership org). */
  clientId: z.string().uuid('clientId doit être un UUID valide'),

  /** UUID de l'entrepôt — vérifié côté service (ownership org). */
  warehouseId: z.string().uuid('warehouseId doit être un UUID valide'),

  /** Date de la vente (ISO 8601). */
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }),

  /** Note libre, max 1000 caractères. */
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),

  /** Taux de TVA global — string décimale, facultatif (défaut "0"). */
  taxRate: nonNegativeDecimalString.optional(),

  /** Remise globale — string décimale, facultatif (défaut "0"). */
  discount: nonNegativeDecimalString.optional(),

  /** Frais de port — string décimale, facultatif (défaut "0"). */
  shipping: nonNegativeDecimalString.optional(),

  /** Lignes de la vente — au moins une ligne requise. */
  details: z
    .array(SaleDetailSchema)
    .min(1, 'La vente doit comporter au moins une ligne'),
});

export type CreateSaleDto = z.infer<typeof CreateSaleSchema>;
export type SaleDetailDto = z.infer<typeof SaleDetailSchema>;
