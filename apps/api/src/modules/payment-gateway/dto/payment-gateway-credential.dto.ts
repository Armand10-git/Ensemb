import { z } from 'zod';

export const PaymentGatewayCredentialSchema = z.object({
  apiKey: z.string().min(1),
  merchantId: z.string().optional(),
  webhookSecret: z.string().min(1),
  isActive: z.boolean().optional(),
});

export type PaymentGatewayCredentialDto = z.infer<typeof PaymentGatewayCredentialSchema>;

/** DTO de sortie public — ne contient jamais apiKeyCipher ni webhookSecretCipher. */
export interface PaymentGatewayCredentialPublicDto {
  id: string;
  organizationId: string;
  merchantId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
