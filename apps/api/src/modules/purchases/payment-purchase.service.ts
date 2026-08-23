import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentType, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import type { CreatePaymentDto } from './dto/create-payment.dto';
import type { UpdatePaymentDto } from './dto/update-payment.dto';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface PaymentPurchaseResponse {
  id: string;
  organizationId: string;
  purchaseId: string;
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

const PAYMENT_SELECT = {
  id: true,
  organizationId: true,
  purchaseId: true,
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
 * Gestion des paiements versés sur un achat fournisseur (S25 — mirror exact de
 * PaymentSaleService, Bloc F, §18.7).
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client ;
 *    dénormalisé sur PaymentPurchase.organizationId pour éviter un join sur chaque contrôle.
 *  - L'ownership de l'achat est vérifiée DANS la transaction avant toute écriture —
 *    élimine le TOCTOU (§17 point IDOR).
 *  - Un paiement ne peut jamais faire dépasser le solde restant de l'achat
 *    (grandTotal − paidAmount), à la création comme à la modification.
 *  - Référence générée via DocumentCounterService.nextReference dans la transaction,
 *    avec DocumentType.PAYMENT_PURCHASE — séquence globale par organisation (§17 point X),
 *    jamais dérivée de la référence de l'achat.
 *  - Purchase.paidAmount/paymentStatus sont recalculés depuis la somme réelle des paiements
 *    après chaque create/update/remove — jamais saisis directement (§17 point 6).
 *  - Suppression physique (pas de soft delete) : PaymentPurchase n'est pas un document
 *    financier au sens de la règle §17 point 7 (pas de DocumentStatus propre) — la
 *    traçabilité est assurée par AuditLog via @Auditable sur la route DELETE.
 */
@Injectable()
export class PaymentPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    @InjectQueue('email')
    private readonly emailQueue: Queue<{ organizationId: string; paymentId: string; to: string }>,
  ) {}

  /**
   * Enregistre un paiement sur un achat et recalcule Purchase.paidAmount/paymentStatus.
   * Ouvre sa propre transaction.
   *
   * @param organizationId - Tenant courant (extrait du token, anti-IDOR).
   * @param userId         - Utilisateur qui encaisse (extrait du token).
   * @param purchaseId     - UUID de l'achat concerné.
   * @param dto            - Montant, moyen de paiement, monnaie rendue, notes.
   * @throws NotFoundException si l'achat est introuvable ou soft-deleted.
   * @throws ForbiddenException si l'achat n'appartient pas à l'organisation.
   * @throws BadRequestException si le montant dépasse le solde restant de l'achat.
   */
  async create(
    organizationId: string,
    userId: string,
    purchaseId: string,
    dto: CreatePaymentDto,
  ): Promise<PaymentPurchaseResponse> {
    return this.prisma.$transaction(async (tx) => {
      const purchase = await this.loadPurchaseForWrite(tx, purchaseId, organizationId);

      const amount = new Decimal(dto.amount);
      const remaining = purchase.grandTotal.minus(purchase.paidAmount);
      if (amount.greaterThan(remaining)) {
        throw new BadRequestException(
          `Le montant dépasse le solde restant (${remaining.toFixed(3)}).`,
        );
      }

      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.PAYMENT_PURCHASE,
      );

      const payment = await tx.paymentPurchase.create({
        data: {
          purchaseId,
          organizationId,
          userId,
          date: new Date(dto.date),
          reference,
          amount,
          method: dto.method,
          change: new Decimal(dto.change ?? '0'),
          notes: dto.notes,
        },
        select: PAYMENT_SELECT,
      });

      await this.recomputePurchaseStatus(tx, purchaseId);

      return payment;
    });
  }

  /**
   * Retourne l'historique chronologique des paiements d'un achat (date ASC puis
   * createdAt ASC). Vérifie l'ownership de l'achat (anti-IDOR).
   */
  async findAllForPurchase(
    purchaseId: string,
    organizationId: string,
  ): Promise<PaymentPurchaseResponse[]> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id: purchaseId },
      select: { organizationId: true, deletedAt: true },
    });

    if (!purchase || purchase.deletedAt !== null) {
      throw new NotFoundException('Achat introuvable.');
    }
    if (purchase.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return this.prisma.paymentPurchase.findMany({
      where: { purchaseId },
      select: PAYMENT_SELECT,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Met à jour un paiement existant. Si le montant change, le solde restant est
   * recalculé en excluant l'ancien montant de ce paiement (sinon il se compterait
   * deux fois). Purchase.paidAmount/paymentStatus sont recalculés dans tous les cas.
   *
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   * @throws BadRequestException si le nouveau montant dépasse le solde restant.
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdatePaymentDto,
  ): Promise<PaymentPurchaseResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.loadPaymentForWrite(tx, id, organizationId);
      const purchase = await this.loadPurchaseForWrite(tx, existing.purchaseId, organizationId);

      let newAmount = existing.amount;
      if (dto.amount !== undefined) {
        newAmount = new Decimal(dto.amount);
        const remainingExcludingThis = purchase.grandTotal.minus(
          purchase.paidAmount.minus(existing.amount),
        );
        if (newAmount.greaterThan(remainingExcludingThis)) {
          throw new BadRequestException(
            `Le montant dépasse le solde restant (${remainingExcludingThis.toFixed(3)}).`,
          );
        }
      }

      const payment = await tx.paymentPurchase.update({
        where: { id },
        data: {
          date: dto.date ? new Date(dto.date) : undefined,
          amount: dto.amount !== undefined ? newAmount : undefined,
          method: dto.method ?? undefined,
          change: dto.change !== undefined ? new Decimal(dto.change) : undefined,
          notes: dto.notes ?? undefined,
        },
        select: PAYMENT_SELECT,
      });

      await this.recomputePurchaseStatus(tx, existing.purchaseId);

      return payment;
    });
  }

  /**
   * Supprime physiquement un paiement (pas de soft delete — cf. JSDoc de classe) et
   * recalcule Purchase.paidAmount/paymentStatus, qui peut redescendre PAID → PARTIAL → UNPAID.
   *
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.loadPaymentForWrite(tx, id, organizationId);

      await tx.paymentPurchase.delete({ where: { id } });

      await this.recomputePurchaseStatus(tx, existing.purchaseId);
    });
  }

  /**
   * Envoie le reçu d'un paiement d'achat au fournisseur par email (S32, mirror exact de
   * PaymentSaleService.send). Enfile un job BullMQ ('paymentPurchase.sendEmail', file 'email')
   * consommé par payment-receipt-email.worker.ts — aucun appel réseau synchrone, retourne dès
   * que le job est enfilé.
   *
   * @param id - identifiant du paiement à envoyer.
   * @param organizationId - organisation de l'utilisateur authentifié (anti-IDOR).
   * @returns `{ status: 'queued' }` dès que le job est enfilé (pas d'attente de l'envoi réel).
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   * @throws BadRequestException si le fournisseur n'a pas d'adresse email enregistrée.
   */
  async send(id: string, organizationId: string): Promise<{ status: 'queued' }> {
    const payment = await this.prisma.paymentPurchase.findUnique({
      where: { id },
      select: {
        organizationId: true,
        purchase: { select: { provider: { select: { email: true } } } },
      },
    });

    if (!payment) {
      throw new NotFoundException('Paiement introuvable.');
    }
    if (payment.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const to = payment.purchase.provider.email;
    if (!to) {
      throw new BadRequestException("Ce fournisseur n'a pas d'adresse email enregistrée.");
    }

    await this.emailQueue.add('paymentPurchase.sendEmail', { organizationId, paymentId: id, to });
    return { status: 'queued' };
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Charge l'achat DANS la transaction et vérifie son ownership (anti-IDOR/TOCTOU).
   * Utilisé avant toute écriture dépendant du solde restant.
   */
  private async loadPurchaseForWrite(
    tx: Prisma.TransactionClient,
    purchaseId: string,
    organizationId: string,
  ): Promise<{ grandTotal: Decimal; paidAmount: Decimal }> {
    const purchase = await tx.purchase.findUnique({
      where: { id: purchaseId },
      select: { organizationId: true, deletedAt: true, grandTotal: true, paidAmount: true },
    });

    if (!purchase || purchase.deletedAt !== null) {
      throw new NotFoundException('Achat introuvable.');
    }
    if (purchase.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return purchase;
  }

  /**
   * Charge un paiement DANS la transaction et vérifie son ownership via son
   * organizationId dénormalisé (anti-IDOR/TOCTOU).
   */
  private async loadPaymentForWrite(
    tx: Prisma.TransactionClient,
    id: string,
    organizationId: string,
  ): Promise<{ purchaseId: string; amount: Decimal }> {
    const payment = await tx.paymentPurchase.findUnique({
      where: { id },
      select: { organizationId: true, purchaseId: true, amount: true },
    });

    if (!payment) {
      throw new NotFoundException('Paiement introuvable.');
    }
    if (payment.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return payment;
  }

  /**
   * Recalcule Purchase.paidAmount à partir de la somme réelle des paiements existants
   * (jamais un simple +/− incrémental, pour rester correct même après une modification
   * ou une suppression) et en déduit paymentStatus (§17 point 6) :
   *   paidAmount ≤ 0        → UNPAID
   *   paidAmount < grandTotal → PARTIAL
   *   sinon                  → PAID
   */
  private async recomputePurchaseStatus(
    tx: Prisma.TransactionClient,
    purchaseId: string,
  ): Promise<void> {
    const purchase = await tx.purchase.findUniqueOrThrow({
      where: { id: purchaseId },
      select: { grandTotal: true },
    });

    const agg = await tx.paymentPurchase.aggregate({
      where: { purchaseId },
      _sum: { amount: true },
    });
    const paidAmount = agg._sum.amount ?? new Decimal(0);

    let paymentStatus: PaymentStatus;
    if (paidAmount.lessThanOrEqualTo(0)) {
      paymentStatus = 'UNPAID';
    } else if (paidAmount.lessThan(purchase.grandTotal)) {
      paymentStatus = 'PARTIAL';
    } else {
      paymentStatus = 'PAID';
    }

    await tx.purchase.update({
      where: { id: purchaseId },
      data: { paidAmount, paymentStatus },
    });
  }
}
