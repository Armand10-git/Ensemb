import { z } from 'zod';

export const PlatformAdminLoginSchema = z.object({
  email: z.string().email('Email invalide'),
  password: z.string().min(1, 'Mot de passe requis'),
});

export type PlatformAdminLoginDto = z.infer<typeof PlatformAdminLoginSchema>;
