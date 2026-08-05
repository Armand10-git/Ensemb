import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentType, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import type { CreatePaymentReturnDto } from './dto/create-payment-return.dto';
import type { UpdatePaymentReturnDto } from './dto/update-payment-return.dto';

// ─── Types internes ──────────────────────────────────────────────────────────

/** Discriminant du parent d'un PaymentReturn — déterminé par la route ou par les FK en base, jamais par le client. */
type ReturnParentKind = 'sale' | 'purchase';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface PaymentReturnResponse {
  id: string;
  organizationId: string;
  saleReturnId: string | null;
  purchaseReturnId: string | null;
  userId: string;
  date: Date;
  reference: string;
  amount: Decimal;
  method: PaymentMethod;
  change: Decimal | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const PAYMENT_RETURN_SELECT = {
  id: true,
  organizationId: true,
  saleReturnId: true,
  purchaseReturnId: true,
  userId: true,
  date: true,
  reference: true,
  amount: true,
  method: true,
  change: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des paiements (remboursements) enregistrés sur un retour de vente ou un
 * retour d'achat fournisseur (S26 — §18.5). Mirror de PaymentSaleService, mais avec
 * deux parents possibles portés par deux FK nullables exclusives sur PaymentReturn
 * (saleReturnId, purchaseReturnId).
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - Le discriminant de parent (vente vs achat) n'est JAMAIS lu depuis le corps de la
 *    requête client : à la création, il est déterminé par la route appelée
 *    (createForSaleReturn / createForPurchaseReturn) ; à la modification/suppression,
 *    il est relu depuis l'enregistrement PaymentReturn existant en base (lequel des
 *    deux FK est non-null). L'autre FK est toujours posée à `null` explicitement lors
 *    de la création — jamais laissée `undefined`.
 *  - L'ownership du parent (SaleReturn ou PurchaseReturn) est vérifiée DANS la
 *    transaction avant toute écriture — élimine le TOCTOU (§17 point IDOR).
 *  - Un paiement ne peut jamais faire dépasser le solde restant du parent
 *    (grandTotal − paidAmount), à la création comme à la modification.
 *  - Référence générée via DocumentCounterService.nextReference dans la transaction,
 *    avec DocumentType.PAYMENT_RETURN — séquence globale par organisation (§17 point X),
 *    indépendante de SaleReturn/PurchaseReturn.
 *  - SaleReturn.paidAmount/paymentStatus (ou PurchaseReturn.paidAmount/paymentStatus)
 *    sont recalculés depuis la somme réelle des PaymentReturn après chaque
 *    create/update/remove — jamais saisis directement (§17 point 6).
 *  - Suppression physique (pas de soft delete) : PaymentReturn n'est pas un document
 *    financier au sens de la règle §17 point 7 — la traçabilité est assurée par
 *    AuditLog via @Auditable sur la route DELETE.
 */
@Injectable()
export class PaymentReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
  ) {}

  /**
   * Enregistre un paiement (remboursement) sur un retour de vente et recalcule
   * SaleReturn.paidAmount/paymentStatus. Ouvre sa propre transaction.
   *
   * @param organizationId - Tenant courant (extrait du token, anti-IDOR).
   * @param userId         - Utilisateur qui enregistre le remboursement (extrait du token).
   * @param saleReturnId   - UUID du retour de vente concerné (extrait de l'URL).
   * @param dto            - Montant, moyen de paiement, monnaie rendue, notes.
   * @throws NotFoundException si le retour de vente est introuvable ou soft-deleted.
   * @throws ForbiddenException si le retour de vente n'appartient pas à l'organisation.
   * @throws BadRequestException si le montant dépasse le solde restant du retour.
   */
  async createForSaleReturn(
    organizationId: string,
    userId: string,
    saleReturnId: string,
    dto: CreatePaymentReturnDto,
  ): Promise<PaymentReturnResponse> {
    return this.prisma.$transaction(async (tx) => {
      const parent = await this.loadReturnForWrite(tx, 'sale', saleReturnId, organizationId);

      const amount = new Decimal(dto.amount);
      const remaining = parent.grandTotal.minus(parent.paidAmount);
      if (amount.greaterThan(remaining)) {
        throw new BadRequestException(
          `Le montant dépasse le solde restant (${remaining.toFixed(3)}).`,
        );
      }

      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.PAYMENT_RETURN,
      );

      const payment = await tx.paymentReturn.create({
        data: {
          saleReturnId,
          purchaseReturnId: null,
          organizationId,
          userId,
          date: new Date(dto.date),
          reference,
          amount,
          method: dto.method,
          change: new Decimal(dto.change ?? '0'),
          notes: dto.notes,
        },
        select: PAYMENT_RETURN_SELECT,
      });

      await this.recomputeReturnStatus(tx, 'sale', saleReturnId);

      return payment;
    });
  }

  /**
   * Enregistre un paiement (remboursement) sur un retour d'achat fournisseur et
   * recalcule PurchaseReturn.paidAmount/paymentStatus. Ouvre sa propre transaction.
   *
   * @param organizationId   - Tenant courant (extrait du token, anti-IDOR).
   * @param userId           - Utilisateur qui enregistre le remboursement (extrait du token).
   * @param purchaseReturnId - UUID du retour d'achat concerné (extrait de l'URL).
   * @param dto              - Montant, moyen de paiement, monnaie rendue, notes.
   * @throws NotFoundException si le retour d'achat est introuvable ou soft-deleted.
   * @throws ForbiddenException si le retour d'achat n'appartient pas à l'organisation.
   * @throws BadRequestException si le montant dépasse le solde restant du retour.
   */
  async createForPurchaseReturn(
    organizationId: string,
    userId: string,
    purchaseReturnId: string,
    dto: CreatePaymentReturnDto,
  ): Promise<PaymentReturnResponse> {
    return this.prisma.$transaction(async (tx) => {
      const parent = await this.loadReturnForWrite(
        tx,
        'purchase',
        purchaseReturnId,
        organizationId,
      );

      const amount = new Decimal(dto.amount);
      const remaining = parent.grandTotal.minus(parent.paidAmount);
      if (amount.greaterThan(remaining)) {
        throw new BadRequestException(
          `Le montant dépasse le solde restant (${remaining.toFixed(3)}).`,
        );
      }

      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.PAYMENT_RETURN,
      );

      const payment = await tx.paymentReturn.create({
        data: {
          saleReturnId: null,
          purchaseReturnId,
          organizationId,
          userId,
          date: new Date(dto.date),
          reference,
          amount,
          method: dto.method,
          change: new Decimal(dto.change ?? '0'),
          notes: dto.notes,
        },
        select: PAYMENT_RETURN_SELECT,
      });

      await this.recomputeReturnStatus(tx, 'purchase', purchaseReturnId);

      return payment;
    });
  }

  /**
   * Retourne l'historique chronologique des paiements d'un retour de vente
   * (date ASC puis createdAt ASC). Vérifie l'ownership du retour (anti-IDOR).
   *
   * @throws NotFoundException si le retour de vente est introuvable ou soft-deleted.
   * @throws ForbiddenException si le retour de vente n'appartient pas à l'organisation.
   */
  async findAllForSaleReturn(
    saleReturnId: string,
    organizationId: string,
  ): Promise<PaymentReturnResponse[]> {
    const saleReturn = await this.prisma.saleReturn.findUnique({
      where: { id: saleReturnId },
      select: { organizationId: true, deletedAt: true },
    });

    if (!saleReturn || saleReturn.deletedAt !== null) {
      throw new NotFoundException('Retour de vente introuvable.');
    }
    if (saleReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return this.prisma.paymentReturn.findMany({
      where: { saleReturnId },
      select: PAYMENT_RETURN_SELECT,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Retourne l'historique chronologique des paiements d'un retour d'achat fournisseur
   * (date ASC puis createdAt ASC). Vérifie l'ownership du retour (anti-IDOR).
   *
   * @throws NotFoundException si le retour d'achat est introuvable ou soft-deleted.
   * @throws ForbiddenException si le retour d'achat n'appartient pas à l'organisation.
   */
  async findAllForPurchaseReturn(
    purchaseReturnId: string,
    organizationId: string,
  ): Promise<PaymentReturnResponse[]> {
    const purchaseReturn = await this.prisma.purchaseReturn.findUnique({
      where: { id: purchaseReturnId },
      select: { organizationId: true, deletedAt: true },
    });

    if (!purchaseReturn || purchaseReturn.deletedAt !== null) {
      throw new NotFoundException('Retour d\'achat introuvable.');
    }
    if (purchaseReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return this.prisma.paymentReturn.findMany({
      where: { purchaseReturnId },
      select: PAYMENT_RETURN_SELECT,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Met à jour un paiement de retour existant, qu'il porte sur une vente ou un achat.
   * Le parent (vente ou achat) n'est jamais reçu du client : il est déterminé depuis
   * les FK du paiement existant chargé en base. Si le montant change, le solde restant
   * est recalculé en excluant l'ancien montant de ce paiement (sinon il se compterait
   * deux fois). paidAmount/paymentStatus du parent sont recalculés dans tous les cas.
   *
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   * @throws BadRequestException si le nouveau montant dépasse le solde restant.
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdatePaymentReturnDto,
  ): Promise<PaymentReturnResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.loadPaymentForWrite(tx, id, organizationId);
      const { parentKind, parentId } = existing;

      const parent = await this.loadReturnForWrite(tx, parentKind, parentId, organizationId);

      let newAmount = existing.amount;
      if (dto.amount !== undefined) {
        newAmount = new Decimal(dto.amount);
        const remainingExcludingThis = parent.grandTotal.minus(
          parent.paidAmount.minus(existing.amount),
        );
        if (newAmount.greaterThan(remainingExcludingThis)) {
          throw new BadRequestException(
            `Le montant dépasse le solde restant (${remainingExcludingThis.toFixed(3)}).`,
          );
        }
      }

      const payment = await tx.paymentReturn.update({
        where: { id },
        data: {
          date: dto.date ? new Date(dto.date) : undefined,
          amount: dto.amount !== undefined ? newAmount : undefined,
          method: dto.method ?? undefined,
          change: dto.change !== undefined ? new Decimal(dto.change) : undefined,
          notes: dto.notes ?? undefined,
        },
        select: PAYMENT_RETURN_SELECT,
      });

      await this.recomputeReturnStatus(tx, parentKind, parentId);

      return payment;
    });
  }

  /**
   * Supprime physiquement un paiement de retour (pas de soft delete — cf. JSDoc de
   * classe) et recalcule paidAmount/paymentStatus du parent concerné (déterminé
   * depuis le paiement chargé AVANT suppression), qui peut redescendre
   * PAID → PARTIAL → UNPAID.
   *
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.loadPaymentForWrite(tx, id, organizationId);

      await tx.paymentReturn.delete({ where: { id } });

      await this.recomputeReturnStatus(tx, existing.parentKind, existing.parentId);
    });
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Charge le retour parent (SaleReturn ou PurchaseReturn selon `parent`) DANS la
   * transaction et vérifie son ownership (anti-IDOR/TOCTOU). Utilisé avant toute
   * écriture dépendant du solde restant.
   *
   * @throws NotFoundException si le retour est introuvable ou soft-deleted.
   * @throws ForbiddenException si le retour n'appartient pas à l'organisation.
   */
  private async loadReturnForWrite(
    tx: Prisma.TransactionClient,
    parent: ReturnParentKind,
    returnId: string,
    organizationId: string,
  ): Promise<{ grandTotal: Decimal; paidAmount: Decimal }> {
    if (parent === 'sale') {
      const saleReturn = await tx.saleReturn.findUnique({
        where: { id: returnId },
        select: { organizationId: true, deletedAt: true, grandTotal: true, paidAmount: true },
      });

      if (!saleReturn || saleReturn.deletedAt !== null) {
        throw new NotFoundException('Retour de vente introuvable.');
      }
      if (saleReturn.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }

      return saleReturn;
    }

    const purchaseReturn = await tx.purchaseReturn.findUnique({
      where: { id: returnId },
      select: { organizationId: true, deletedAt: true, grandTotal: true, paidAmount: true },
    });

    if (!purchaseReturn || purchaseReturn.deletedAt !== null) {
      throw new NotFoundException('Retour d\'achat introuvable.');
    }
    if (purchaseReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return purchaseReturn;
  }

  /**
   * Charge un paiement de retour DANS la transaction, vérifie son ownership via son
   * organizationId dénormalisé (anti-IDOR/TOCTOU), et détermine son parent (vente ou
   * achat) depuis celui des deux FK qui est non-null — jamais depuis le client.
   *
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   */
  private async loadPaymentForWrite(
    tx: Prisma.TransactionClient,
    id: string,
    organizationId: string,
  ): Promise<{ amount: Decimal; parentKind: ReturnParentKind; parentId: string }> {
    const payment = await tx.paymentReturn.findUnique({
      where: { id },
      select: {
        organizationId: true,
        saleReturnId: true,
        purchaseReturnId: true,
        amount: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Paiement introuvable.');
    }
    if (payment.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    // Invariant garanti à la création (une seule des deux FK non-null) et défendu par
    // la contrainte CHECK SQL en base — cf. JSDoc du modèle PaymentReturn.
    const parentKind: ReturnParentKind = payment.saleReturnId !== null ? 'sale' : 'purchase';
    const parentId =
      parentKind === 'sale'
        ? (payment.saleReturnId as string)
        : (payment.purchaseReturnId as string);

    return { amount: payment.amount, parentKind, parentId };
  }

  /**
   * Recalcule paidAmount du parent (SaleReturn ou PurchaseReturn selon `parent`) à
   * partir de la somme réelle des PaymentReturn existants (jamais un simple +/−
   * incrémental, pour rester correct même après une modification ou une suppression)
   * et en déduit paymentStatus (§17 point 6) :
   *   paidAmount ≤ 0          → UNPAID
   *   paidAmount < grandTotal → PARTIAL
   *   sinon                   → PAID
   */
  private async recomputeReturnStatus(
    tx: Prisma.TransactionClient,
    parent: ReturnParentKind,
    returnId: string,
  ): Promise<void> {
    if (parent === 'sale') {
      const saleReturn = await tx.saleReturn.findUniqueOrThrow({
        where: { id: returnId },
        select: { grandTotal: true },
      });

      const agg = await tx.paymentReturn.aggregate({
        where: { saleReturnId: returnId },
        _sum: { amount: true },
      });
      const paidAmount = agg._sum.amount ?? new Decimal(0);
      const paymentStatus = this.derivePaymentStatus(paidAmount, saleReturn.grandTotal);

      await tx.saleReturn.update({
        where: { id: returnId },
        data: { paidAmount, paymentStatus },
      });

      return;
    }

    const purchaseReturn = await tx.purchaseReturn.findUniqueOrThrow({
      where: { id: returnId },
      select: { grandTotal: true },
    });

    const agg = await tx.paymentReturn.aggregate({
      where: { purchaseReturnId: returnId },
      _sum: { amount: true },
    });
    const paidAmount = agg._sum.amount ?? new Decimal(0);
    const paymentStatus = this.derivePaymentStatus(paidAmount, purchaseReturn.grandTotal);

    await tx.purchaseReturn.update({
      where: { id: returnId },
      data: { paidAmount, paymentStatus },
    });
  }

  /**
   * Dérive PaymentStatus depuis paidAmount et grandTotal (§17 point 6) — factorisé
   * pour éviter la duplication entre les deux branches de recomputeReturnStatus.
   */
  private derivePaymentStatus(paidAmount: Decimal, grandTotal: Decimal): PaymentStatus {
    if (paidAmount.lessThanOrEqualTo(0)) {
      return 'UNPAID';
    }
    if (paidAmount.lessThan(grandTotal)) {
      return 'PARTIAL';
    }
    return 'PAID';
  }
}
