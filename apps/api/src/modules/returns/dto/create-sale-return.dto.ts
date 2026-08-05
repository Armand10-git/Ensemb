import { z } from 'zod';

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, strictement positif.
 * Ex. : "5", "10.500", "0.001" → valides ; "0", "-1" → rejetés par le raffinement.
 * Mirror exact de create-sale.dto.ts (S19) — même contrat de validation côté quantité.
 */
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Doit être un nombre décimal positif (ex. "5" ou "10.500")')
  .refine((v) => parseFloat(v) > 0, { message: 'La quantité doit être strictement positive.' });

/**
 * Ligne d'un retour de vente (S26). Le client ne fournit QUE la ligne de vente d'origine
 * (saleDetailId), la quantité retournée et une unité de retour optionnelle — price/taxAmount/
 * taxMethod/discount/discountMethod ne sont JAMAIS saisis par le client : ils sont toujours
 * copiés depuis la SaleDetail source par le service (décision de conception S26, anti-manipulation
 * de prix sur un retour).
 */
export const SaleReturnDetailSchema = z.object({
  /** UUID de la ligne de vente d'origine — ownership + appartenance au Sale vérifiées côté service. */
  saleDetailId: z.string().uuid('saleDetailId doit être un UUID valide'),

  /** UUID de l'unité de retour choisie pour cette ligne — optionnel, mirror saleUnitId. */
  returnUnitId: z.string().uuid('returnUnitId doit être un UUID valide').optional(),

  /** Quantité retournée — string décimale convertie en Decimal dans le service. Toujours > 0. */
  quantity: positiveDecimalString,
});

/**
 * Corps de création d'un retour de vente. saleId est obligatoire (un retour n'existe pas sans
 * vente source, COMPLETED — vérifié côté service). warehouseId n'est PAS un champ d'entrée :
 * il est toujours copié depuis sale.warehouseId. Pas de taxRate/discount/shipping d'en-tête —
 * grandTotal est la simple somme des lignes (§ décision de conception S26).
 */
export const CreateSaleReturnSchema = z.object({
  /** UUID de la vente d'origine — doit être COMPLETED et appartenir à l'organisation. */
  saleId: z.string().uuid('saleId doit être un UUID valide'),

  /** Date du retour (ISO 8601). */
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }),

  /** Note libre, max 1000 caractères. */
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),

  /** Lignes du retour — au moins une ligne requise. */
  details: z
    .array(SaleReturnDetailSchema)
    .min(1, 'Le retour doit comporter au moins une ligne'),
});

export type CreateSaleReturnDto = z.infer<typeof CreateSaleReturnSchema>;
export type SaleReturnDetailDto = z.infer<typeof SaleReturnDetailSchema>;
