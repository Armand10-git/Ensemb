import { z } from 'zod';

/** Raison d'annulation obligatoire (§18.18 point 2 — irréversible, raison exigée). */
export const CancelSaleSchema = z.object({
  reason: z
    .string()
    .min(3, 'La raison doit comporter au moins 3 caractères.')
    .max(500, 'La raison ne peut pas dépasser 500 caractères.'),
});

export type CancelSaleDto = z.infer<typeof CancelSaleSchema>;
