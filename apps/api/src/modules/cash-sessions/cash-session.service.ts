import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentType, PaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import type { OpenCashSessionDto, CloseCashSessionDto } from './dto/cash-session.dto';
import type { PaginatedResult } from '../../common/types';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface CashSessionResponse {
  id: string;
  organizationId: string;
  reference: string;
  warehouseId: string;
  userId: string;
  openingAmount: Decimal;
  expectedClosingAmount: Decimal | null;
  countedClosingAmount: Decimal | null;
  variance: Decimal | null;
  /** "OPEN" | "CLOSED" — String simple, pas d'enum Prisma dédié (choix volontaire, cf. schema). */
  status: string;
  notes: string | null;
  openedAt: Date;
  closedAt: Date | null;
}

/** Sous-total léger d'une vente rattachée à une session — cf. JSDoc de findOne. */
export interface CashSessionSaleSummary {
  reference: string;
  grandTotal: Decimal;
}

export interface CashSessionDetailResponse extends CashSessionResponse {
  sales: CashSessionSaleSummary[];
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const CASH_SESSION_SELECT = {
  id: true,
  organizationId: true,
  reference: true,
  warehouseId: true,
  userId: true,
  openingAmount: true,
  expectedClosingAmount: true,
  countedClosingAmount: true,
  variance: true,
  status: true,
  notes: true,
  openedAt: true,
  closedAt: true,
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des sessions de caisse (S23b, §18.2) : ouverture/clôture, fond de caisse, écart.
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - warehouseId vérifie l'ownership de l'organisation avant tout accès (anti-IDOR).
 *  - "Chacun sa caisse" : une seule session OPEN par (organizationId, userId), imposée par un
 *    index unique partiel en base (cash_sessions_org_user_open_key) en défense en profondeur
 *    au-delà du contrôle applicatif dans open().
 *  - Référence générée via DocumentCounterService.nextReference, dans la transaction (§17 point X).
 *  - openingAmount / expectedClosingAmount / countedClosingAmount / variance sont Decimal —
 *    jamais Float (§17 point A).
 *  - close() ne peut être appelé que par le caissier propriétaire de la session (IDOR) : une
 *    clôture par un manager pour un autre caissier est hors périmètre de S23b.
 *  - CARD et MOBILE_MONEY sont exclus du calcul de expectedClosingAmount : ces moyens de
 *    paiement ne touchent jamais le tiroir-caisse physique, seul CASH y transite.
 */
@Injectable()
export class CashSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
  ) {}

  /**
   * Ouvre une nouvelle session de caisse pour l'utilisateur courant sur l'entrepôt donné.
   * Vérifie l'ownership du warehouseId (anti-IDOR) puis qu'aucune session OPEN n'existe déjà
   * pour (organizationId, userId) — "chacun sa caisse". La référence est générée dans la
   * transaction de création (DocumentCounterService, jamais max+1).
   *
   * @param organizationId - UUID de l'organisation (extrait du token, jamais du body)
   * @param userId         - UUID du caissier ouvrant la session (extrait du token)
   * @param dto            - warehouseId + openingAmount (fond de caisse déclaré)
   * @returns La session de caisse créée, status OPEN.
   * @throws NotFoundException si l'entrepôt est introuvable.
   * @throws ForbiddenException si l'entrepôt n'appartient pas à l'organisation.
   * @throws ConflictException si une session OPEN existe déjà pour cet utilisateur — contrôle
   *         applicatif, doublé d'un filet de sécurité sur la violation P2002 de l'index unique
   *         partiel en cas de course concurrente (TOCTOU entre le check et le commit).
   */
  async open(
    organizationId: string,
    userId: string,
    dto: OpenCashSessionDto,
  ): Promise<CashSessionResponse> {
    await this.verifyWarehouseOwnership(dto.warehouseId, organizationId);

    const existingOpen = await this.prisma.cashSession.findFirst({
      where: { organizationId, userId, status: 'OPEN' },
      select: { id: true },
    });
    if (existingOpen) {
      throw new ConflictException(
        'Une session de caisse est déjà ouverte pour cet utilisateur.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const reference = await this.documentCounter.nextReference(
          tx,
          organizationId,
          DocumentType.CASH_SESSION,
        );

        return tx.cashSession.create({
          data: {
            organizationId,
            reference,
            warehouseId: dto.warehouseId,
            userId,
            openingAmount: new Decimal(dto.openingAmount),
            status: 'OPEN',
          },
          select: CASH_SESSION_SELECT,
        });
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          'Une session de caisse est déjà ouverte pour cet utilisateur.',
        );
      }
      throw err;
    }
  }

  /**
   * Retourne la session de caisse OPEN de l'utilisateur courant pour l'entrepôt donné, ou
   * null si aucune session n'est ouverte (pas d'exception — cas nominal avant la première
   * vente de la journée). Vérifie l'ownership du warehouseId fourni en filtre (anti-oracle
   * d'énumération, même patron que AdjustmentService.findAll).
   */
  async findCurrent(
    organizationId: string,
    userId: string,
    warehouseId: string,
  ): Promise<CashSessionResponse | null> {
    await this.verifyWarehouseOwnership(warehouseId, organizationId);

    return this.prisma.cashSession.findFirst({
      where: { organizationId, userId, warehouseId, status: 'OPEN' },
      select: CASH_SESSION_SELECT,
    });
  }

  /**
   * Contrat consommé par PosService.createSale (S23b → câblé par un agent suivant) : recherche
   * la session OPEN de (organizationId, userId, warehouseId) DANS la transaction Serializable
   * de création de la vente, pour rattacher cashSessionId sans TOCTOU — la session ne peut pas
   * être clôturée entre la vérification et l'écriture puisque les deux se produisent dans la
   * même transaction.
   *
   * @param tx             - Client de transaction Prisma (DOIT être appelé dans une transaction active)
   * @param organizationId - UUID de l'organisation tenant
   * @param userId         - UUID du caissier (propriétaire attendu de la session)
   * @param warehouseId    - UUID de l'entrepôt de la vente
   * @returns { id, reference } de la session OPEN correspondante, ou null si aucune — à
   *          l'appelant de traiter l'absence comme une erreur bloquante si une session est
   *          requise pour créer la vente (ex. BadRequestException dans PosService.createSale).
   */
  async findOpenSessionInTransaction(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
    warehouseId: string,
  ): Promise<{ id: string; reference: string } | null> {
    return tx.cashSession.findFirst({
      where: { organizationId, userId, warehouseId, status: 'OPEN' },
      select: { id: true, reference: true },
    });
  }

  /**
   * Clôture une session de caisse : calcule expectedClosingAmount (fond de caisse + somme des
   * paiements CASH des ventes rattachées), pose variance = compté - attendu, et passe
   * status = CLOSED. Seul le caissier propriétaire de la session peut la clôturer (IDOR).
   *
   * Le check de statut et le calcul sont effectués DANS une transaction Serializable pour
   * éliminer le TOCTOU (patron identique à AdjustmentService.validate) : deux clôtures
   * concurrentes sur la même session ne peuvent pas toutes deux passer le check OPEN.
   * Si dto.notes est fourni, il remplace la note existante ; sinon la note existante est
   * conservée telle quelle.
   *
   * @throws NotFoundException si la session est introuvable.
   * @throws ForbiddenException si l'organisation ne correspond pas, ou si l'appelant n'est pas
   *         le caissier propriétaire de la session (une clôture par un manager pour un autre
   *         caissier est hors périmètre de S23b).
   * @throws BadRequestException si la session est déjà CLOSED.
   * @throws ConflictException en cas de conflit de sérialisation détecté par PostgreSQL (P2034).
   */
  async close(
    id: string,
    organizationId: string,
    userId: string,
    dto: CloseCashSessionDto,
  ): Promise<CashSessionResponse> {
    return this.prisma
      .$transaction(
        async (tx) => {
          const existing = await tx.cashSession.findUnique({
            where: { id },
            select: CASH_SESSION_SELECT,
          });

          if (!existing) {
            throw new NotFoundException('Session de caisse introuvable.');
          }
          if (existing.organizationId !== organizationId) {
            throw new ForbiddenException('Accès refusé.');
          }
          if (existing.userId !== userId) {
            throw new ForbiddenException(
              'Seul le caissier propriétaire de cette session peut la clôturer.',
            );
          }
          if (existing.status === 'CLOSED') {
            throw new BadRequestException('Cette session de caisse est déjà clôturée.');
          }

          // Somme des paiements CASH des ventes rattachées à cette session — CARD et
          // MOBILE_MONEY ne touchent jamais le tiroir physique, exclus volontairement.
          const cashPayments = await tx.paymentSale.aggregate({
            where: {
              organizationId,
              method: PaymentMethod.CASH,
              sale: { cashSessionId: id },
            },
            _sum: { amount: true },
          });

          const expectedClosingAmount = existing.openingAmount.plus(
            cashPayments._sum.amount ?? new Decimal(0),
          );
          const countedClosingAmount = new Decimal(dto.countedClosingAmount);
          const variance = countedClosingAmount.minus(expectedClosingAmount);

          return tx.cashSession.update({
            where: { id },
            data: {
              expectedClosingAmount,
              countedClosingAmount,
              variance,
              status: 'CLOSED',
              closedAt: new Date(),
              notes: dto.notes ?? existing.notes,
            },
            select: CASH_SESSION_SELECT,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
          throw new ConflictException('Conflit de concurrence détecté. Veuillez réessayer.');
        }
        throw err;
      });
  }

  /**
   * Retourne la liste paginée des sessions de caisse de l'organisation.
   * viewAll=false restreint aux sessions ouvertes par l'utilisateur appelant (patron
   * ViewAllInterceptor / records.viewAll, cf. SaleController). Filtrable par warehouseId et
   * status ("OPEN" | "CLOSED").
   */
  async findAll(
    organizationId: string,
    userId: string,
    viewAll: boolean,
    page: number,
    limit: number,
    warehouseId?: string,
    status?: string,
  ): Promise<PaginatedResult<CashSessionResponse>> {
    if (warehouseId) {
      await this.verifyWarehouseOwnership(warehouseId, organizationId);
    }

    const where: Prisma.CashSessionWhereInput = {
      organizationId,
      ...(viewAll ? {} : { userId }),
      ...(warehouseId ? { warehouseId } : {}),
      ...(status ? { status } : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.cashSession.findMany({
        where,
        select: CASH_SESSION_SELECT,
        orderBy: { openedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.cashSession.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  /**
   * Retourne le détail d'une session de caisse, avec le sous-total des ventes rattachées.
   * viewAll=false restreint aux sessions ouvertes par l'utilisateur appelant (patron
   * ViewAllInterceptor / records.viewAll, identique à findAll et à close()) : sans cette
   * permission, un caissier ne peut consulter en détail (fond de caisse, écart, ventes
   * rattachées) que SA propre session, jamais celle d'un collègue — l'isolation d'organisation
   * seule ne suffit pas dans un contexte multi-caissier (§ revue sécurité S23b).
   *
   * Choix de forme (documenté ici faute de spécification stricte) : une liste légère
   * { reference, grandTotal } par vente plutôt que les ventes complètes — suffisant pour
   * l'écran de récapitulatif de clôture, sans dupliquer SaleController.findOne ; le détail
   * complet d'une vente reste accessible via GET /sales/:id si nécessaire.
   */
  async findOne(
    id: string,
    organizationId: string,
    userId: string,
    viewAll: boolean,
  ): Promise<CashSessionDetailResponse> {
    const session = await this.prisma.cashSession.findUnique({
      where: { id },
      select: CASH_SESSION_SELECT,
    });

    if (!session) {
      throw new NotFoundException('Session de caisse introuvable.');
    }
    if (session.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (!viewAll && session.userId !== userId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const sales = await this.prisma.sale.findMany({
      where: { organizationId, cashSessionId: id },
      select: { reference: true, grandTotal: true },
      orderBy: { createdAt: 'asc' },
    });

    return { ...session, sales };
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Vérifie que l'entrepôt appartient à l'organisation (anti-IDOR).
   */
  private async verifyWarehouseOwnership(
    warehouseId: string,
    organizationId: string,
  ): Promise<void> {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { organizationId: true, deletedAt: true },
    });

    if (!warehouse || warehouse.deletedAt !== null) {
      throw new NotFoundException('Entrepôt introuvable.');
    }
    if (warehouse.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé à cet entrepôt.');
    }
  }
}
