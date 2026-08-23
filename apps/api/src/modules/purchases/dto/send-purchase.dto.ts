import { z } from 'zod';

/**
 * Envoi d'un achat ou d'un reçu de paiement d'achat au fournisseur par email ou SMS (S32/S33,
 * mirror exact de send-sale.dto.ts). Le canal détermine le contact requis sur le fournisseur
 * (email ou téléphone) — vérifié côté service, pas ici (le DTO ne valide que la forme du body,
 * pas les données métier). Réutilisé par PurchaseController et PaymentPurchaseController.
 */
export const SendPurchaseSchema = z.object({
  channel: z.enum(['email', 'sms']),
});

export type SendPurchaseDto = z.infer<typeof SendPurchaseSchema>;
