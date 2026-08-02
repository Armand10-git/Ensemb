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

/** Ligne d'un achat fournisseur — mirror exact de SaleDetailSchema (purchaseUnitId au lieu de saleUnitId). */
export const PurchaseDetailSchema = z.object({
  /** UUID du produit acheté. Vérifié côté service (ownership org). */
  productId: z.string().uuid('productId doit être un UUID valide'),

  /** UUID de la variante — optionnel. */
  productVariantId: z.string().uuid('productVariantId doit être un UUID valide').optional(),

  /** UUID de l'unité d'achat choisie pour cette ligne — optionnel. */
  purchaseUnitId: z.string().uuid('purchaseUnitId doit être un UUID valide').optional(),

  /** Prix unitaire (coût d'achat) — string décimale, non négatif. */
  price: nonNegativeDecimalString,

  /** Quantité achetée — string décimale convertie en Decimal dans le service. Toujours > 0. */
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

export const CreatePurchaseSchema = z.object({
  /** UUID du fournisseur — vérifié côté service (ownership org). */
  providerId: z.string().uuid('providerId doit être un UUID valide'),

  /** UUID de l'entrepôt — vérifié côté service (ownership org). */
  warehouseId: z.string().uuid('warehouseId doit être un UUID valide'),

  /** Date de l'achat (ISO 8601). */
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }),

  /** Note libre, max 1000 caractères. */
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),

  /** Taux de TVA global — string décimale, facultatif (défaut "0"). */
  taxRate: nonNegativeDecimalString.optional(),

  /** Remise globale — string décimale, facultatif (défaut "0"). */
  discount: nonNegativeDecimalString.optional(),

  /** Frais de port — string décimale, facultatif (défaut "0"). */
  shipping: nonNegativeDecimalString.optional(),

  /** Lignes de l'achat — au moins une ligne requise. */
  details: z
    .array(PurchaseDetailSchema)
    .min(1, "L'achat doit comporter au moins une ligne"),
});

export type CreatePurchaseDto = z.infer<typeof CreatePurchaseSchema>;
export type PurchaseDetailDto = z.infer<typeof PurchaseDetailSchema>;
