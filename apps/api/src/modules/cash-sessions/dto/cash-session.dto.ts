import { z } from 'zod';

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, non négatif.
 * Ex. : "0", "1500.500" → valides.
 * Dupliquée depuis pos-sale.dto.ts / create-adjustment.dto.ts — patron existant du module API
 * (pas de package de validation partagé côté API, cf. CLAUDE.md), pas de factorisation à inventer.
 */
const nonNegativeDecimalString = z
  .string()
  .regex(
    /^\d+(\.\d{1,3})?$/,
    'Doit être un nombre décimal non négatif (ex. "0" ou "1500.500")',
  );

/**
 * POST /cash-sessions/open — ouverture d'une session de caisse.
 * warehouseId vérifié côté service (ownership org, anti-IDOR).
 * openingAmount : fond de caisse déclaré, string décimale non négative (0 accepté).
 */
export const OpenCashSessionSchema = z.object({
  warehouseId: z.string().uuid('warehouseId doit être un UUID valide'),
  openingAmount: nonNegativeDecimalString,
});

export type OpenCashSessionDto = z.infer<typeof OpenCashSessionSchema>;

/**
 * PATCH /cash-sessions/:id/close — clôture d'une session de caisse.
 * countedClosingAmount : comptage physique saisi par le caissier, string décimale non négative.
 * notes : commentaire libre optionnel (ex. justification d'un écart), max 1000 caractères.
 */
export const CloseCashSessionSchema = z.object({
  countedClosingAmount: nonNegativeDecimalString,
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),
});

export type CloseCashSessionDto = z.infer<typeof CloseCashSessionSchema>;
