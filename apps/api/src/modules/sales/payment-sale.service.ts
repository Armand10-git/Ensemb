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

export interface PaymentSaleResponse {
  id: string;
  organizationId: string;
  saleId: string;
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
  saleId: true,
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
 * Gestion des paiements encaissés sur une vente classique (S20 — complète le stub
 * PaymentSale posé en S19, Bloc E, §18.5).
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client ;
 *    dénormalisé sur PaymentSale.organizationId pour éviter un join sur chaque contrôle.
 *  - L'ownership de la vente est vérifiée DANS la transaction avant toute écriture —
 *    élimine le TOCTOU (§17 point IDOR).
 *  - Un paiement ne peut jamais faire dépasser le solde restant de la vente
 *    (grandTotal − paidAmount), à la création comme à la modification.
 *  - Référence générée via DocumentCounterService.nextReference dans la transaction,
 *    avec DocumentType.PAYMENT_SALE — séquence globale par organisation (§17 point X),
 *    jamais dérivée de la référence de la vente.
 *  - Sale.paidAmount/paymentStatus sont recalculés depuis la somme réelle des paiements
 *    après chaque create/update/remove — jamais saisis directement (§17 point 6).
 *  - Suppression physique (pas de soft delete) : PaymentSale n'est pas un document
 *    financier au sens de la règle §17 point 7 (pas de DocumentStatus propre) — la
 *    traçabilité est assurée par AuditLog via @Auditable sur la route DELETE.
 */
@Injectable()
export class PaymentSaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    @InjectQueue('email')
    private readonly emailQueue: Queue<{ organizationId: string; paymentId: string; to: string }>,
  ) {}

  /**
   * Enregistre un paiement sur une vente et recalcule Sale.paidAmount/paymentStatus.
   * Ouvre sa propre transaction — cf. createInTransaction() pour l'appel depuis une
   * transaction déjà ouverte par un autre service (PosModule, S22).
   *
   * @param organizationId - Tenant courant (extrait du token, anti-IDOR).
   * @param userId         - Utilisateur qui encaisse (extrait du token).
   * @param saleId         - UUID de la vente concernée.
   * @param dto            - Montant, moyen de paiement, monnaie rendue, notes.
   * @throws NotFoundException si la vente est introuvable ou soft-deleted.
   * @throws ForbiddenException si la vente n'appartient pas à l'organisation.
   * @throws BadRequestException si le montant dépasse le solde restant de la vente.
   */
  async create(
    organizationId: string,
    userId: string,
    saleId: string,
    dto: CreatePaymentDto,
  ): Promise<PaymentSaleResponse> {
    return this.prisma.$transaction((tx) =>
      this.createInTransaction(tx, organizationId, userId, saleId, dto),
    );
  }

  /**
   * Coeur de create() — extrait pour être appelable DANS une transaction Serializable déjà
   * ouverte par un autre service (PosService.createSale/confirmPayment, S22), afin que la
   * création de la vente, le décrément de stock et l'encaissement immédiat CASH/CARD restent
   * une seule opération atomique. Ne PAS appeler directement depuis un contexte HTTP — passer
   * par create() qui ouvre sa propre transaction.
   */
  async createInTransaction(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
    saleId: string,
    dto: CreatePaymentDto,
  ): Promise<PaymentSaleResponse> {
    const sale = await this.loadSaleForWrite(tx, saleId, organizationId);

    const amount = new Decimal(dto.amount);
    const remaining = sale.grandTotal.minus(sale.paidAmount);
    if (amount.greaterThan(remaining)) {
      throw new BadRequestException(
        `Le montant dépasse le solde restant (${remaining.toFixed(3)}).`,
      );
    }

    const reference = await this.documentCounter.nextReference(
      tx,
      organizationId,
      DocumentType.PAYMENT_SALE,
    );

    const payment = await tx.paymentSale.create({
      data: {
        saleId,
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

    await this.recomputeSaleStatus(tx, saleId);

    return payment;
  }

  /**
   * Retourne l'historique chronologique des paiements d'une vente (date ASC puis
   * createdAt ASC). Vérifie l'ownership de la vente (anti-IDOR).
   */
  async findAllForSale(
    saleId: string,
    organizationId: string,
  ): Promise<PaymentSaleResponse[]> {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      select: { organizationId: true, deletedAt: true },
    });

    if (!sale || sale.deletedAt !== null) {
      throw new NotFoundException('Vente introuvable.');
    }
    if (sale.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return this.prisma.paymentSale.findMany({
      where: { saleId },
      select: PAYMENT_SELECT,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Met à jour un paiement existant. Si le montant change, le solde restant est
   * recalculé en excluant l'ancien montant de ce paiement (sinon il se compterait
   * deux fois). Sale.paidAmount/paymentStatus sont recalculés dans tous les cas.
   *
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   * @throws BadRequestException si le nouveau montant dépasse le solde restant.
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdatePaymentDto,
  ): Promise<PaymentSaleResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.loadPaymentForWrite(tx, id, organizationId);
      const sale = await this.loadSaleForWrite(tx, existing.saleId, organizationId);

      let newAmount = existing.amount;
      if (dto.amount !== undefined) {
        newAmount = new Decimal(dto.amount);
        const remainingExcludingThis = sale.grandTotal.minus(
          sale.paidAmount.minus(existing.amount),
        );
        if (newAmount.greaterThan(remainingExcludingThis)) {
          throw new BadRequestException(
            `Le montant dépasse le solde restant (${remainingExcludingThis.toFixed(3)}).`,
          );
        }
      }

      const payment = await tx.paymentSale.update({
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

      await this.recomputeSaleStatus(tx, existing.saleId);

      return payment;
    });
  }

  /**
   * Supprime physiquement un paiement (pas de soft delete — cf. JSDoc de classe) et
   * recalcule Sale.paidAmount/paymentStatus, qui peut redescendre PAID → PARTIAL → UNPAID.
   *
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   */
  async remove(id: string, organizationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.loadPaymentForWrite(tx, id, organizationId);

      await tx.paymentSale.delete({ where: { id } });

      await this.recomputeSaleStatus(tx, existing.saleId);
    });
  }

  /**
   * Envoie le reçu d'un paiement de vente au client par email (S32, mirror exact de
   * SaleService.send — un seul canal email, pas de body attendu). Enfile un job BullMQ
   * ('paymentSale.sendEmail', file 'email') consommé par payment-receipt-email.worker.ts —
   * aucun appel réseau synchrone, retourne dès que le job est enfilé.
   *
   * @param id - identifiant du paiement à envoyer.
   * @param organizationId - organisation de l'utilisateur authentifié (anti-IDOR).
   * @returns `{ status: 'queued' }` dès que le job est enfilé (pas d'attente de l'envoi réel).
   * @throws NotFoundException si le paiement est introuvable.
   * @throws ForbiddenException si le paiement n'appartient pas à l'organisation.
   * @throws BadRequestException si le client n'a pas d'adresse email enregistrée.
   */
  async send(id: string, organizationId: string): Promise<{ status: 'queued' }> {
    const payment = await this.prisma.paymentSale.findUnique({
      where: { id },
      select: {
        organizationId: true,
        sale: { select: { client: { select: { email: true } } } },
      },
    });

    if (!payment) {
      throw new NotFoundException('Paiement introuvable.');
    }
    if (payment.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const to = payment.sale.client.email;
    if (!to) {
      throw new BadRequestException("Ce client n'a pas d'adresse email enregistrée.");
    }

    await this.emailQueue.add('paymentSale.sendEmail', { organizationId, paymentId: id, to });
    return { status: 'queued' };
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Charge la vente DANS la transaction et vérifie son ownership (anti-IDOR/TOCTOU).
   * Utilisé avant toute écriture dépendant du solde restant.
   */
  private async loadSaleForWrite(
    tx: Prisma.TransactionClient,
    saleId: string,
    organizationId: string,
  ): Promise<{ grandTotal: Decimal; paidAmount: Decimal }> {
    const sale = await tx.sale.findUnique({
      where: { id: saleId },
      select: { organizationId: true, deletedAt: true, grandTotal: true, paidAmount: true },
    });

    if (!sale || sale.deletedAt !== null) {
      throw new NotFoundException('Vente introuvable.');
    }
    if (sale.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return sale;
  }

  /**
   * Charge un paiement DANS la transaction et vérifie son ownership via son
   * organizationId dénormalisé (anti-IDOR/TOCTOU).
   */
  private async loadPaymentForWrite(
    tx: Prisma.TransactionClient,
    id: string,
    organizationId: string,
  ): Promise<{ saleId: string; amount: Decimal }> {
    const payment = await tx.paymentSale.findUnique({
      where: { id },
      select: { organizationId: true, saleId: true, amount: true },
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
   * Recalcule Sale.paidAmount à partir de la somme réelle des paiements existants
   * (jamais un simple +/− incrémental, pour rester correct même après une modification
   * ou une suppression) et en déduit paymentStatus (§17 point 6) :
   *   paidAmount ≤ 0        → UNPAID
   *   paidAmount < grandTotal → PARTIAL
   *   sinon                  → PAID
   */
  private async recomputeSaleStatus(
    tx: Prisma.TransactionClient,
    saleId: string,
  ): Promise<void> {
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: { grandTotal: true },
    });

    const agg = await tx.paymentSale.aggregate({
      where: { saleId },
      _sum: { amount: true },
    });
    const paidAmount = agg._sum.amount ?? new Decimal(0);

    let paymentStatus: PaymentStatus;
    if (paidAmount.lessThanOrEqualTo(0)) {
      paymentStatus = 'UNPAID';
    } else if (paidAmount.lessThan(sale.grandTotal)) {
      paymentStatus = 'PARTIAL';
    } else {
      paymentStatus = 'PAID';
    }

    await tx.sale.update({
      where: { id: saleId },
      data: { paidAmount, paymentStatus },
    });
  }
}
