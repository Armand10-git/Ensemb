import { z } from 'zod';

export const SmtpServerSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(587),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
  fromEmail: z.string().email().max(255),
  fromName: z.string().min(1).max(255),
});

export type SmtpServerDto = z.infer<typeof SmtpServerSchema>;

/** DTO de sortie — ne contient jamais passwordCipher ni le mot de passe en clair. */
export interface SmtpServerPublicDto {
  id: string;
  organizationId: string;
  host: string;
  port: number;
  username: string;
  fromEmail: string;
  fromName: string;
  createdAt: Date;
  updatedAt: Date;
}
