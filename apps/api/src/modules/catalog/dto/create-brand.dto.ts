import { z } from 'zod';

export const CreateBrandSchema = z.object({
  name: z
    .string()
    .min(1, 'Le nom est obligatoire')
    .max(100, 'Le nom ne peut pas dépasser 100 caractères'),
  description: z.string().max(500, 'La description ne peut pas dépasser 500 caractères').optional(),
  /** URL d'un logo de marque — upload réel reporté à S13. */
  image: z
    .string()
    .url("L'URL de l'image est invalide")
    .max(2048)
    .optional(),
});

export const UpdateBrandSchema = CreateBrandSchema.partial();

export type CreateBrandDto = z.infer<typeof CreateBrandSchema>;
export type UpdateBrandDto = z.infer<typeof UpdateBrandSchema>;
