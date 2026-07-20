import { z } from 'zod';

export const CreateUnitSchema = z.object({
  name: z
    .string()
    .min(1, 'Le nom est obligatoire')
    .max(100, 'Le nom ne peut pas dépasser 100 caractères'),
  shortName: z
    .string()
    .min(1, 'Le nom court est obligatoire')
    .max(20, 'Le nom court ne peut pas dépasser 20 caractères'),
  baseUnitId: z.string().uuid('baseUnitId doit être un UUID valide').optional(),
  operator: z.enum(['*', '/'], { message: "L'opérateur doit être \"*\" ou \"/\"" }),
  /** Sérialisé en string (ex. "12", "0.5") — converti en Decimal dans le service */
  operatorValue: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "operatorValue doit être un nombre décimal positif (ex. \"12\" ou \"0.5\")"),
});

export const UpdateUnitSchema = CreateUnitSchema.partial();

export type CreateUnitDto = z.infer<typeof CreateUnitSchema>;
export type UpdateUnitDto = z.infer<typeof UpdateUnitSchema>;
