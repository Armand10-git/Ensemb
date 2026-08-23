import { z } from 'zod';

/**
 * Envoi d'un récapitulatif de retour (vente ou fournisseur) par email ou SMS (S33, mirror
 * exact de send-sale.dto.ts). Le canal détermine le contact requis sur la contrepartie (email
 * ou téléphone) — vérifié côté service, pas ici (le DTO ne valide que la forme du body, pas
 * les données métier). Réutilisé par SaleReturnController et PurchaseReturnController.
 */
export const SendReturnSchema = z.object({
  channel: z.enum(['email', 'sms']),
});

export type SendReturnDto = z.infer<typeof SendReturnSchema>;
