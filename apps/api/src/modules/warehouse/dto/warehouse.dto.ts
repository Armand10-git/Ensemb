import { z } from 'zod';

export const CreateWarehouseSchema = z.object({
  name: z.string().min(1, 'Le nom est obligatoire').max(100),
  address: z.string().max(255).optional(),
  isDefault: z.boolean().default(false),
});

export const UpdateWarehouseSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  address: z.string().max(255).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export type CreateWarehouseDto = z.infer<typeof CreateWarehouseSchema>;
export type UpdateWarehouseDto = z.infer<typeof UpdateWarehouseSchema>;
