/** Type des documents financiers — doit rester en sync avec l'enum Prisma DocumentType. */
export type DocumentType =
  | 'SALE'
  | 'PURCHASE'
  | 'QUOTATION'
  | 'SALE_RETURN'
  | 'PURCHASE_RETURN'
  | 'TRANSFER'
  | 'ADJUSTMENT';

const PREFIXES: Record<DocumentType, string> = {
  SALE: 'VTE',
  PURCHASE: 'ACH',
  QUOTATION: 'DEV',
  SALE_RETURN: 'RVT',
  PURCHASE_RETURN: 'RAC',
  TRANSFER: 'TRF',
  ADJUSTMENT: 'AJT',
};

/**
 * Génère la référence lisible d'un document financier.
 *
 * Format : <PREFIX>-<YEAR>-<COUNTER_PADDED_6>
 * Exemple : VTE-2026-000001, ACH-2026-000042
 *
 * Pas de troncature : si le compteur dépasse 999999, il déborde naturellement
 * (VTE-2026-1000000) — la largeur de 6 est un minimum, pas un maximum.
 *
 * @param documentType - Type de document (enum Prisma DocumentType)
 * @param year         - Année civile (ex. 2026)
 * @param counter      - Valeur courante du compteur (> 0)
 * @returns Référence formatée
 */
export function formatReference(
  documentType: DocumentType,
  year: number,
  counter: number,
): string {
  return `${PREFIXES[documentType]}-${year}-${String(counter).padStart(6, '0')}`;
}
