import { z } from 'zod';

export const CreateCurrencySchema = z.object({
  code: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z]+$/, 'Le code doit être en majuscules (ex. XAF, EUR)'),
  name: z.string().min(1).max(100),
  symbol: z.string().min(1).max(10),
  symbolPosition: z.enum(['BEFORE', 'AFTER']).default('AFTER'),
  decimalPlaces: z.number().int().min(0).max(8).default(0),
  isActive: z.boolean().default(true),
});

export const UpdateCurrencySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  symbol: z.string().min(1).max(10).optional(),
  symbolPosition: z.enum(['BEFORE', 'AFTER']).optional(),
  decimalPlaces: z.number().int().min(0).max(8).optional(),
  isActive: z.boolean().optional(),
});

export const UpdateDefaultCurrencySchema = z.object({
  currencyId: z.string().uuid('currencyId doit être un UUID valide'),
});

export type CreateCurrencyDto = z.infer<typeof CreateCurrencySchema>;
export type UpdateCurrencyDto = z.infer<typeof UpdateCurrencySchema>;
export type UpdateDefaultCurrencyDto = z.infer<typeof UpdateDefaultCurrencySchema>;
