import { z } from 'zod';

export const SubscribeSchema = z.object({
  planId: z.string().uuid('planId doit être un UUID valide.'),
  period: z.enum(['monthly', 'annual'] as const, {
    error: 'period doit être "monthly" ou "annual".',
  }),
});

export type SubscribeDto = z.infer<typeof SubscribeSchema>;
