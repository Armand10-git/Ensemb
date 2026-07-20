import { z } from 'zod';

export const CreateCategorySchema = z.object({
  /** Code métier court — majuscules et chiffres uniquement, ex. "ELEC", "ALI". */
  code: z
    .string()
    .min(1, 'Le code est obligatoire')
    .max(20, 'Le code ne peut pas dépasser 20 caractères')
    .regex(/^[A-Z0-9]+$/, 'Le code doit contenir uniquement des majuscules (A–Z) et des chiffres'),
  name: z
    .string()
    .min(1, 'Le nom est obligatoire')
    .max(100, 'Le nom ne peut pas dépasser 100 caractères'),
});

export const UpdateCategorySchema = CreateCategorySchema.partial();

export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;
export type UpdateCategoryDto = z.infer<typeof UpdateCategorySchema>;
