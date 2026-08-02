import { z } from 'zod';
import { PurchaseReturnDetailSchema } from './create-purchase-return.dto';

/**
 * Mêmes champs que CreatePurchaseReturnSchema, tous optionnels — n'est autorisé côté
 * service que si le retour est encore au statut PENDING (§17 point 7 : un document
 * COMPLETED est immuable). purchaseId n'est volontairement PAS modifiable ici : changer
 * l'achat d'origine d'un retour déjà créé casserait l'invariant IDOR (chaque ligne doit
 * appartenir au purchaseId déclaré) — un retour erroné doit être supprimé (PENDING) et
 * recréé plutôt que réassigné à un autre achat.
 */
export const UpdatePurchaseReturnSchema = z.object({
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }).optional(),
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),
  details: z
    .array(PurchaseReturnDetailSchema)
    .min(1, 'Le retour doit comporter au moins une ligne')
    .optional(),
});

export type UpdatePurchaseReturnDto = z.infer<typeof UpdatePurchaseReturnSchema>;
