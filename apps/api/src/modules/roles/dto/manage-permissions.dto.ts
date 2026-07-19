import { z } from 'zod';

export const ManagePermissionsSchema = z.object({
  permissionIds: z
    .array(z.string().uuid('Chaque permission doit être un UUID valide'))
    .min(1, 'Au moins une permission est requise'),
});

export type ManagePermissionsDto = z.infer<typeof ManagePermissionsSchema>;
