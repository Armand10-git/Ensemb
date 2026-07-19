import { z } from 'zod';

export const AssignRoleSchema = z.object({
  userId: z.string().uuid('userId doit être un UUID valide'),
});

export type AssignRoleDto = z.infer<typeof AssignRoleSchema>;
