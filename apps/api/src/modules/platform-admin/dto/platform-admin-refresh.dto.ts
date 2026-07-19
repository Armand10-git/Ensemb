import { z } from 'zod';

export const PlatformAdminRefreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken requis'),
});

export type PlatformAdminRefreshDto = z.infer<typeof PlatformAdminRefreshSchema>;
