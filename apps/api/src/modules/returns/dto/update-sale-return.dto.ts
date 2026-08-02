import { z } from 'zod';
import { SaleReturnDetailSchema } from './create-sale-return.dto';

/**
 * Corps de mise à jour d'un retour de vente — n'est autorisé côté service que si le retour
 * est encore au statut PENDING (§17 point 7 : un document COMPLETED est immuable). saleId
 * n'est volontairement PAS modifiable ici (mirror de la décision « warehouseId non modifiable »
 * de SaleReturn : la vente d'origine est fixée à la création, changer saleId reviendrait à
 * changer la nature même du document plutôt qu'à le corriger). Si `details` est fourni, chaque
 * ligne est re-vérifiée par le service contre le MÊME saleId existant (anti-IDOR, réutilise la
 * logique de create()).
 */
export const UpdateSaleReturnSchema = z.object({
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }).optional(),
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),
  details: z
    .array(SaleReturnDetailSchema)
    .min(1, 'Le retour doit comporter au moins une ligne')
    .optional(),
});

export type UpdateSaleReturnDto = z.infer<typeof UpdateSaleReturnSchema>;
