import { z } from 'zod';

/**
 * Envoi d'un récapitulatif de devis au client par email ou SMS (S28, mirror exact de
 * SendSaleSchema — S24). Le canal détermine le contact requis sur le client (email ou
 * téléphone) — vérifié côté service, pas ici (le DTO ne valide que la forme du body,
 * pas les données métier).
 */
export const SendQuotationSchema = z.object({
  channel: z.enum(['email', 'sms']),
});

export type SendQuotationDto = z.infer<typeof SendQuotationSchema>;
