import { z } from 'zod';

export const PlatformAdminTotpVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Le code TOTP doit contenir exactement 6 chiffres'),
});

export type PlatformAdminTotpVerifyDto = z.infer<typeof PlatformAdminTotpVerifySchema>;
