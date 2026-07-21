import { Injectable } from '@nestjs/common';
import { DocumentType, Prisma } from '@prisma/client';
import { formatReference } from '@ensemb/utils';

/**
 * Service de génération transactionnelle des références de documents (§17 point X).
 *
 * CONTRAINTE IMPÉRATIVE : nextReference DOIT être appelé dans une transaction Prisma —
 * jamais en dehors. L'atomicité est garantie par l'incrément SQL effectué sur la ligne
 * verrouillée dans la transaction parente.
 *
 * L'incrément est réalisé via un upsert Prisma avec update: { lastCounter: { increment: 1 } }
 * ce qui se traduit en un UPDATE ... SET last_counter = last_counter + 1 RETURNING ...
 * atomique — jamais de SELECT puis UPDATE séparés.
 */
@Injectable()
export class DocumentCounterService {
  /**
   * Incrémente le compteur de (organizationId, documentType, year) dans la transaction
   * fournie et retourne la référence formatée.
   *
   * @param tx             - Client de transaction Prisma (DOIT être dans une transaction active)
   * @param organizationId - UUID de l'organisation tenant
   * @param documentType   - Type de document (SALE, PURCHASE, etc.)
   * @param year           - Année civile (défaut : année UTC courante)
   * @returns Référence formatée, ex. "VTE-2026-000001"
   */
  async nextReference(
    tx: Prisma.TransactionClient,
    organizationId: string,
    documentType: DocumentType,
    year?: number,
  ): Promise<string> {
    const targetYear = year ?? new Date().getUTCFullYear();

    // Upsert atomique : crée le compteur s'il n'existe pas (lastCounter = 1 = 0+1),
    // ou l'incrémente de 1 s'il existe déjà. Aucun SELECT séparé.
    const counter = await tx.documentCounter.upsert({
      where: {
        organizationId_documentType_year: {
          organizationId,
          documentType,
          year: targetYear,
        },
      },
      create: {
        organizationId,
        documentType,
        year: targetYear,
        lastCounter: 1,
      },
      update: {
        lastCounter: { increment: 1 },
      },
      select: { lastCounter: true },
    });

    return formatReference(documentType, targetYear, counter.lastCounter);
  }
}
