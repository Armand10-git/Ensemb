/**
 * Types de document PDF supportés (S34, périmètre exact de la session — pas de reçu de
 * paiement, contrairement à email/SMS S24/S32/S33).
 */
export type PdfDocumentType = 'sale' | 'purchase' | 'quotation' | 'saleReturn' | 'purchaseReturn';

/**
 * Contrat du job de la file `pdf` (S34).
 * Lire ce commentaire suffit pour enfiler un job correctement, sans lire le corps du worker —
 * mirror exact du patron déjà utilisé pour la file `email` (cf. sale-email.worker.ts).
 *
 *   queue : 'pdf'
 *   job.name : '<documentType>.generatePdf' (ex. 'sale.generatePdf', 'saleReturn.generatePdf')
 *   job.data : PdfJobData
 */
export interface PdfJobData {
  /** Organisation propriétaire du document (§17 point 12) — jamais déduite implicitement. */
  organizationId: string;
  documentType: PdfDocumentType;
  /** Identifiant du document à rendre (Sale.id, Purchase.id, Quotation.id, SaleReturn.id ou PurchaseReturn.id). */
  documentId: string;
  /** Utilisateur ayant déclenché la génération — journalisation/traçabilité uniquement. */
  requestedBy: string;
}

/** Nom de job BullMQ pour un type de document donné — évite une chaîne magique dupliquée entre contrôleur et worker. */
export function pdfJobName(documentType: PdfDocumentType): string {
  return `${documentType}.generatePdf`;
}
