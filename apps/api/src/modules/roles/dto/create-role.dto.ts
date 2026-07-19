import { z } from 'zod';

export const CreateRoleSchema = z.object({
  name: z
    .string()
    .min(2, 'Le nom doit comporter au moins 2 caractères')
    .max(64, 'Le nom ne peut pas dépasser 64 caractères')
    .regex(/^[a-z0-9._-]+$/, 'Le nom doit être en minuscules (lettres, chiffres, ., _, -)'),
  label: z.string().max(128).optional(),
  description: z.string().max(512).optional(),
});

export type CreateRoleDto = z.infer<typeof CreateRoleSchema>;
