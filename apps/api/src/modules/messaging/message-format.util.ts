import type { Decimal } from '@prisma/client/runtime/library';

/**
 * Formate un montant Decimal en XAF pour affichage humain (aucune décimale — le franc CFA
 * ne s'utilise pas en sous-unité dans l'usage courant). Purement pour le rendu ; les calculs
 * monétaires eux-mêmes restent en Decimal côté serveur (§17 point 1) — cette fonction ne fait
 * que formater un résultat déjà calculé.
 */
export function formatAmount(amount: Decimal): string {
  return `${amount.toNumber().toLocaleString('fr-FR')} XAF`;
}

/**
 * Échappe les caractères HTML spéciaux d'une chaîne insérée dans un template email —
 * empêche toute injection HTML via un nom de client/fournisseur ou une note contenant des
 * balises (§17 point « XSS » — même hygiène appliquée ici bien qu'il s'agisse d'un email,
 * pas d'une page web rendue dans un navigateur contrôlé par nous).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formate une date pour affichage humain en français (jour/mois/année).
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('fr-FR');
}
