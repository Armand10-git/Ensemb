import { z } from 'zod';

/**
 * Schéma de création d'une catégorie de dépense (S29).
 * Mirror exact de CreateBrandSchema — donnée de référence tenant simple, pas de champ image.
 */
export const CreateExpenseCategorySchema = z.object({
  name: z
    .string()
    .min(1, 'Le nom est obligatoire')
    .max(100, 'Le nom ne peut pas dépasser 100 caractères'),
  description: z
    .string()
    .max(500, 'La description ne peut pas dépasser 500 caractères')
    .optional(),
});

export const UpdateExpenseCategorySchema = CreateExpenseCategorySchema.partial();

export type CreateExpenseCategoryDto = z.infer<typeof CreateExpenseCategorySchema>;
export type UpdateExpenseCategoryDto = z.infer<typeof UpdateExpenseCategorySchema>;
