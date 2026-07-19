import { z } from 'zod';

export const RequestExportSchema = z.object({
  format: z.enum(['CSV', 'JSON']).default('CSV'),
});

export type RequestExportDto = z.infer<typeof RequestExportSchema>;
