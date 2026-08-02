import { z } from 'zod';

/**
 * Envoi d'un récapitulatif de vente au client par email ou SMS (S24, §18.3 étape 4).
 * Le canal détermine le contact requis sur le client (email ou téléphone) — vérifié
 * côté service, pas ici (le DTO ne valide que la forme du body, pas les données métier).
 */
export const SendSaleSchema = z.object({
  channel: z.enum(['email', 'sms']),
});

export type SendSaleDto = z.infer<typeof SendSaleSchema>;
