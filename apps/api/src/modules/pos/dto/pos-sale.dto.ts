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

/** Ligne de vente POS — même forme que SaleDetailSchema (S19), réutilisée pour calculate-total ET sales. */
export const PosLineSchema = z.object({
  productId: z.string().uuid('productId doit être un UUID valide'),
  productVariantId: z.string().uuid('productVariantId doit être un UUID valide').optional(),
  saleUnitId: z.string().uuid('saleUnitId doit être un UUID valide').optional(),
  price: nonNegativeDecimalString,
  quantity: positiveDecimalString,
  taxAmount: nonNegativeDecimalString.optional(),
  taxMethod: z.enum(['percentage', 'fixed'] as const).optional(),
  discount: nonNegativeDecimalString.optional(),
  discountMethod: z.enum(['percentage', 'fixed'] as const).optional(),
});

/**
 * POST /pos/calculate-total — aucun champ de total n'est accepté du client (§17 point A) :
 * seuls les éléments d'entrée du calcul (lignes + taux/remise/frais d'en-tête) sont pris.
 */
export const CalculateTotalSchema = z.object({
  taxRate: nonNegativeDecimalString.optional(),
  discount: nonNegativeDecimalString.optional(),
  shipping: nonNegativeDecimalString.optional(),
  details: z.array(PosLineSchema).min(1, 'Le panier doit comporter au moins une ligne'),
});

export type CalculateTotalDto = z.infer<typeof CalculateTotalSchema>;
export type PosLineDto = z.infer<typeof PosLineSchema>;

/**
 * POST /pos/sales — même base que CalculateTotalSchema + identité du panier (client, entrepôt)
 * et mode de règlement. amountReceived n'est obligatoire qu'en espèces (cf. refine ci-dessous) —
 * en carte le montant réglé est exactement grandTotal, en mobile money aucun paiement n'est
 * créé à cette étape (flux asynchrone, §17 point V).
 */
export const CreatePosSaleSchema = CalculateTotalSchema.extend({
  clientId: z.string().uuid('clientId doit être un UUID valide'),
  warehouseId: z.string().uuid('warehouseId doit être un UUID valide'),
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }).optional(),
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),
  paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY'] as const),
  amountReceived: nonNegativeDecimalString.optional(),
}).refine((data) => data.paymentMethod !== 'CASH' || data.amountReceived !== undefined, {
  message: 'amountReceived est obligatoire pour un paiement en espèces.',
  path: ['amountReceived'],
});

export type CreatePosSaleDto = z.infer<typeof CreatePosSaleSchema>;
