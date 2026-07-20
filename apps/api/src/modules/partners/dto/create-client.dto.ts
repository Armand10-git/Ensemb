import { z } from 'zod';

/**
 * DTO de création/modification d'un client.
 * Le champ `code` est auto-généré par le service — jamais fourni par l'utilisateur.
 * Validation zod partagée client/serveur (§17 point 11).
 */
export const CreateClientSchema = z.object({
  name:    z.string().min(1).max(255),
  email:   z.string().email().optional(),
  phone:   z.string().max(30).optional(),
  country: z.string().max(255).optional(),
  city:    z.string().max(255).optional(),
  address: z.string().max(255).optional(),
});

export const UpdateClientSchema = CreateClientSchema.partial();

export type CreateClientDto = z.infer<typeof CreateClientSchema>;
export type UpdateClientDto = z.infer<typeof UpdateClientSchema>;
