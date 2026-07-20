import { z } from 'zod';

/**
 * DTO de création/modification d'un fournisseur.
 * Le champ `code` est auto-généré par le service — jamais fourni par l'utilisateur.
 */
export const CreateProviderSchema = z.object({
  name:    z.string().min(1).max(255),
  email:   z.string().email().optional(),
  phone:   z.string().max(30).optional(),
  country: z.string().max(255).optional(),
  city:    z.string().max(255).optional(),
  address: z.string().max(255).optional(),
});

export const UpdateProviderSchema = CreateProviderSchema.partial();

export type CreateProviderDto = z.infer<typeof CreateProviderSchema>;
export type UpdateProviderDto = z.infer<typeof UpdateProviderSchema>;
