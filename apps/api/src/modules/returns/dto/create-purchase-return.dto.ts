import { z } from 'zod';

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, strictement positif.
 * Ex. : "5", "10.500", "0.001" → valides ; "0", "-1" → rejetés par le raffinement.
 * Mirror exact de la regex utilisée dans create-purchase.dto.ts.
 */
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Doit être un nombre décimal positif (ex. "5" ou "10.500")')
  .refine((v) => parseFloat(v) > 0, { message: 'La quantité doit être strictement positive.' });

/**
 * Ligne d'un retour fournisseur. Contrairement à PurchaseDetailSchema (achat), le client
 * ne fournit PAS price/taxAmount/taxMethod/discount/discountMethod : ces valeurs sont
 * toujours copiées côté serveur depuis la PurchaseDetail source référencée par
 * purchaseDetailId (cf. PurchaseReturnService.create) — décision de conception S26,
 * identique au retour de vente (SaleReturn) pour cohérence entre les deux domaines.
 */
export const PurchaseReturnDetailSchema = z.object({
  /** UUID de la ligne d'achat d'origine — ownership + appartenance au purchaseId vérifiées côté service. */
  purchaseDetailId: z.string().uuid('purchaseDetailId doit être un UUID valide'),

  /** Quantité retournée — string décimale convertie en Decimal dans le service. Toujours > 0. */
  quantity: positiveDecimalString,

  /** UUID de l'unité de retour choisie pour cette ligne — optionnel (mirror purchaseUnitId). */
  returnUnitId: z.string().uuid('returnUnitId doit être un UUID valide').optional(),
});

/**
 * Création d'un retour fournisseur (S26). Aucun champ d'en-tête taxRate/discount/shipping
 * n'est exposé : ces valeurs restent à 0 sur PurchaseReturn (cf. commentaire du modèle
 * Prisma) — seul le total des lignes (recalculé côté serveur) compose grandTotal.
 */
export const CreatePurchaseReturnSchema = z.object({
  /** UUID de l'achat d'origine — doit être COMPLETED, vérifié côté service (ownership org). */
  purchaseId: z.string().uuid('purchaseId doit être un UUID valide'),

  /** Date du retour (ISO 8601). */
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }),

  /** Note libre, max 1000 caractères. */
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),

  /** Lignes du retour — au moins une ligne requise. */
  details: z
    .array(PurchaseReturnDetailSchema)
    .min(1, 'Le retour doit comporter au moins une ligne'),
});

export type CreatePurchaseReturnDto = z.infer<typeof CreatePurchaseReturnSchema>;
export type PurchaseReturnDetailDto = z.infer<typeof PurchaseReturnDetailSchema>;
