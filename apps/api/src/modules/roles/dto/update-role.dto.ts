import { z } from 'zod';

export const UpdateRoleSchema = z.object({
  label: z.string().max(128).optional(),
  description: z.string().max(512).optional(),
  status: z.boolean().optional(),
});

export type UpdateRoleDto = z.infer<typeof UpdateRoleSchema>;
