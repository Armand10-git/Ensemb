import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentStatus, DocumentType, PaymentStatus, Prisma } from '@prisma/client';
import { convertToBase } from '@ensemb/utils';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  ProductWarehouseService,
  OptimisticLockException,
} from '../inventory/product-warehouse.service';
import { NotificationService } from '../notifications/notification.service';
import type { CreateSaleDto, SaleDetailDto } from './dto/create-sale.dto';
import type { UpdateSaleDto } from './dto/update-sale.dto';
import type { PaginatedResult } from '../../common/types';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface SaleDetailResponse {
  id: string;
  productId: string;
  productVariantId: string | null;
  saleUnitId: string | null;
  price: Decimal;
  taxAmount: Decimal | null;
  taxMethod: string | null;
  discount: Decimal | null;
  discountMethod: string | null;
  quantity: Decimal;
  total: Decimal;
}

export interface SaleResponse {
  id: string;
  organizationId: string;
  reference: string;
  date: Date;
  isPos: boolean;
  userId: string;
  clientId: string;
  warehouseId: string;
  taxRate: Decimal | null;
  taxAmount: Decimal | null;
  discount: Decimal | null;
  shipping: Decimal | null;
  grandTotal: Decimal;
  paidAmount: Decimal;
  paymentStatus: PaymentStatus;
  status: DocumentStatus;
  notes: string | null;
  cancelReason: string | null;
  cancelledAt: Date | null;
  cancelledById: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  client?: { id: string; name: string };
  warehouse?: { id: string; name: string };
  details?: SaleDetailResponse[];
}

/** Résultat d'un mouvement de stock appliqué par validate()/cancel() — pour stock:updated/lowAlert. */
interface StockUpdate {
  productId: string;
  newQuantity: Decimal;
  productName: string;
  stockAlert: number;
}

/** Ligne de vente après calcul serveur — jamais confiance dans un total client (§17 point A). */
interface ComputedLine {
  productId: string;
  productVariantId: string | null;
  saleUnitId: string | null;
  price: Decimal;
  taxAmount: Decimal;
  taxMethod: string;
  discount: Decimal;
  discountMethod: string;
  quantity: Decimal;
  total: Decimal;
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const SALE_SELECT = {
  id: true,
  organizationId: true,
  reference: true,
  date: true,
  isPos: true,
  userId: true,
  clientId: true,
  warehouseId: true,
  taxRate: true,
  taxAmount: true,
  discount: true,
  shipping: true,
  grandTotal: true,
  paidAmount: true,
  paymentStatus: true,
  status: true,
  notes: true,
  cancelReason: true,
  cancelledAt: true,
  cancelledById: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DETAIL_SELECT = {
  id: true,
  productId: true,
  productVariantId: true,
  saleUnitId: true,
  price: true,
  taxAmount: true,
  taxMethod: true,
  discount: true,
  discountMethod: true,
  quantity: true,
  total: true,
} as const;

const CLIENT_WAREHOUSE_INCLUDE = {
  // email/phone ajoutés en S24 (envoi email/SMS du récapitulatif) — ajout additif,
  // ne casse aucun usage existant (create/validate/cancel/findOne ignorent simplement
  // ces deux champs supplémentaires).
  client: { select: { id: true, name: true, email: true, phone: true } },
  warehouse: { select: { id: true, name: true } },
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des ventes classiques hors-POS (S19 — Bloc E, §18.3).
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - clientId, warehouseId et chaque productId/productVariantId/saleUnitId vérifient
 *    l'ownership DANS la transaction avant tout accès — élimine le TOCTOU.
 *  - Tous les totaux (ligne et en-tête) sont calculés côté serveur — jamais depuis
 *    le body client (§17 point A). price/quantity/taxAmount/discount en Decimal.
 *  - Référence générée via DocumentCounterService.nextReference dans la transaction (§17 point X).
 *  - S19 ne décrémente jamais le stock (S21) ni n'enregistre de paiement (S20) :
 *    paidAmount = 0, paymentStatus = UNPAID à la création.
 *  - Seule une vente PENDING peut être modifiée ou supprimée (§17 point 7) ; une vente
 *    COMPLETED ou CANCELLED est immuable.
 *  - Le taux de TVA d'en-tête (taxRate) est toujours un pourcentage — aucun champ
 *    d'entrée pour un montant de taxe fixe n'est exposé côté en-tête (contrairement aux
 *    lignes, qui ont taxMethod/discountMethod). La remise d'en-tête (discount) est
 *    toujours un montant XAF fixe soustrait du total, sans mode pourcentage — c'est la
 *    seule lecture cohérente avec les champs réellement exposés par CreateSaleDto.
 *  - validate() (S21) et cancel() (S21b) sont les SEULES actions qui mouvementent le stock
 *    d'une vente classique : décrément (validate) ou restitution (cancel) de ProductWarehouse
 *    via ProductWarehouseService.adjustStock (verrouillage optimiste, transaction Serializable),
 *    conversion d'unité saleUnitId → unité de stock du produit via convertToBase, indépendant
 *    de paymentStatus/PaymentSale (S20). Regroupement/conversion et mouvement de stock sont
 *    factorisés dans groupDetailsByProduct/moveStock, partagés par les deux méthodes.
 *  - cancel() est réutilisable en interne (pas seulement via HTTP) : le job d'expiration
 *    mobile money (S22, PosModule) l'appelle directement avec actorId: null.
 */
@Injectable()
export class SaleService {
  private readonly logger = new Logger(SaleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly productWarehouseService: ProductWarehouseService,
    private readonly notificationService: NotificationService,
    // Files BullMQ d'envoi de récapitulatif de vente (S24) — le worker recharge lui-même
    // la vente à partir de saleId, aucun autre payload que l'organisationId/saleId/to
    // n'est transporté (§17 point 12 — tout job transporte son organizationId).
    @InjectQueue('email')
    private readonly emailQueue: Queue<{ organizationId: string; saleId: string; to: string }>,
    @InjectQueue('sms')
    private readonly smsQueue: Queue<{ organizationId: string; saleId: string; to: string }>,
  ) {}

  /**
   * Crée une vente en statut PENDING avec ses lignes dans une transaction.
   * Référence générée via DocumentCounterService.nextReference. Émet sale:created
   * vers org:{organizationId} (S19 ne crée que des ventes classiques, isPos=false).
   *
   * @throws NotFoundException si le client, l'entrepôt, un produit, une variante ou
   *         une unité de vente est introuvable.
   * @throws ForbiddenException si l'une de ces ressources n'appartient pas à l'organisation.
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateSaleDto,
  ): Promise<SaleResponse> {
    const sale = await this.prisma.$transaction(async (tx) => {
      await this.verifyClientOwnership(tx, dto.clientId, organizationId);
      await this.verifyWarehouseOwnership(tx, dto.warehouseId, organizationId);
      await this.verifyDetailsOwnership(tx, dto.details, organizationId);

      const computed = dto.details.map((d) => this.computeLineTotal(d));
      const sumLines = computed.reduce((acc, d) => acc.plus(d.total), new Decimal(0));

      const taxRate = new Decimal(dto.taxRate ?? '0');
      const discount = new Decimal(dto.discount ?? '0');
      const shipping = new Decimal(dto.shipping ?? '0');
      const taxGlobal = sumLines.times(taxRate).dividedBy(100);
      const grandTotal = sumLines.plus(taxGlobal).minus(discount).plus(shipping);

      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.SALE,
      );

      return tx.sale.create({
        data: {
          organizationId,
          reference,
          date: new Date(dto.date),
          isPos: false,
          userId,
          clientId: dto.clientId,
          warehouseId: dto.warehouseId,
          taxRate,
          taxAmount: taxGlobal,
          discount,
          shipping,
          grandTotal,
          paidAmount: new Decimal(0),
          paymentStatus: 'UNPAID',
          status: 'PENDING',
          notes: dto.notes,
          details: { create: computed.map((d) => this.toDetailCreateInput(d)) },
        },
        select: { ...SALE_SELECT, ...CLIENT_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
      });
    });

    if (!sale.isPos) {
      this.realtimeGateway.server.to(`org:${organizationId}`).emit('sale:created', {
        organizationId,
        saleId: sale.id,
        warehouseId: sale.warehouseId,
        grandTotal: sale.grandTotal,
      });
    }

    return sale;
  }

  /**
   * Valide une vente PENDING : décrémente le stock de l'entrepôt de la vente pour
   * chaque ligne (regroupées par couple produit/variante, converties dans l'unité de
   * stock du produit via convertToBase si saleUnitId diffère), puis fait passer le
   * statut à COMPLETED — le tout dans une seule transaction Serializable.
   *
   * Indépendant de paymentStatus/PaymentSale (S20) : une vente peut être validée
   * (stock mouvementé) sans être payée — le paiement suit son propre cycle asynchrone.
   *
   * La vente et ses lignes sont relues DANS la transaction Serializable pour éliminer
   * le TOCTOU : deux requêtes concurrentes de validation sur la même vente ne peuvent
   * pas toutes deux passer le contrôle PENDING et double-décrémenter le stock. Les
   * lignes sont regroupées par (productId, productVariantId) et sommées AVANT tout
   * appel à adjustStock — un seul mouvement cumulé par couple produit/variante, jamais
   * un appel par ligne brute (sinon la 2e ligne du même produit utiliserait une version
   * déjà obsolète après le premier adjustStock).
   *
   * @throws NotFoundException si la vente, un ProductWarehouse ou une unité de vente
   *         référencée est introuvable.
   * @throws ForbiddenException si la vente n'appartient pas à l'organisation.
   * @throws BadRequestException si la vente n'est pas PENDING, ou si le stock disponible
   *         est insuffisant pour une ligne.
   * @throws ConflictException si un conflit de version optimiste ou de sérialisation (P2034).
   */
  async validate(id: string, organizationId: string): Promise<SaleResponse> {
    let stockUpdates: StockUpdate[] = [];
    let capturedWarehouseId!: string;

    await this.prisma
      .$transaction(
        async (tx) => {
          // 1. Relire la vente + lignes DANS la transaction Serializable (élimine le TOCTOU).
          const existing = await tx.sale.findUnique({
            where: { id },
            select: { ...SALE_SELECT, details: { select: DETAIL_SELECT } },
          });

          if (!existing || existing.deletedAt !== null) {
            throw new NotFoundException('Vente introuvable.');
          }
          if (existing.organizationId !== organizationId) {
            throw new ForbiddenException('Accès refusé.');
          }
          if (existing.status !== 'PENDING') {
            throw new BadRequestException(
              'Seule une vente en attente (PENDING) peut être validée.',
            );
          }

          capturedWarehouseId = existing.warehouseId;

          // 2-4. Regroupement par (productId, productVariantId) avec conversion d'unité.
          const grouped = await this.groupDetailsByProduct(tx, existing.details);

          // 5. Décrément (garde stock insuffisant AVANT adjustStock).
          stockUpdates = await this.moveStock(
            tx,
            organizationId,
            existing.warehouseId,
            grouped,
            'decrement',
          );

          // 6. Statut
          await tx.sale.update({ where: { id }, data: { status: 'COMPLETED' } });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => this.rethrowStockConflict(err));

    this.emitStockEvents(organizationId, capturedWarehouseId, stockUpdates);

    return this.prisma.sale.findUniqueOrThrow({
      where: { id },
      select: { ...SALE_SELECT, ...CLIENT_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
    });
  }

  /**
   * Annule une vente dont le stock a déjà été mouvementé — COMPLETED (S21b, §18.18) ou
   * AWAITING_PAYMENT (S22, expiration mobile money, §18.2 étape 10 : le stock est déjà
   * décrémenté à la création POS, avant même la confirmation du paiement) : restitue le
   * stock — même regroupement/conversion d'unité que validate(), delta positif — puis
   * fait passer le statut à CANCELLED avec raison/horodatage/acteur. Le tout dans une
   * seule transaction Serializable, vente et lignes relues DANS la transaction (même
   * patron anti-TOCTOU que validate()).
   *
   * Réutilisable en interne (pas seulement via HTTP) : appelée directement par le job
   * d'expiration mobile money (S22) avec actorId: null (aucun contexte HTTP) — c'est la
   * raison pour laquelle S21b et S22 partagent cette méthode plutôt que de dupliquer la
   * logique de restitution entre une annulation manuelle et une expiration automatique.
   * Le paiement déjà encaissé n'est PAS touché — un remboursement est un acte séparé
   * (§18.18 point 4, hors périmètre de cette session).
   *
   * @param actorId - utilisateur à l'origine de l'annulation, ou null si système (expiration).
   * @throws NotFoundException si la vente est introuvable.
   * @throws ForbiddenException si la vente n'appartient pas à l'organisation.
   * @throws BadRequestException si la vente est PENDING ou déjà CANCELLED (stock jamais mouvementé
   *         ou déjà restitué — pas de double restitution).
   * @throws ConflictException si un conflit de version optimiste ou de sérialisation (P2034).
   */
  async cancel(
    id: string,
    organizationId: string,
    { reason, actorId }: { reason: string; actorId: string | null },
  ): Promise<SaleResponse> {
    let stockUpdates: StockUpdate[] = [];
    let capturedWarehouseId!: string;

    await this.prisma
      .$transaction(
        async (tx) => {
          const existing = await tx.sale.findUnique({
            where: { id },
            select: { ...SALE_SELECT, details: { select: DETAIL_SELECT } },
          });

          if (!existing || existing.deletedAt !== null) {
            throw new NotFoundException('Vente introuvable.');
          }
          if (existing.organizationId !== organizationId) {
            throw new ForbiddenException('Accès refusé.');
          }
          if (existing.status !== 'COMPLETED' && existing.status !== 'AWAITING_PAYMENT') {
            throw new BadRequestException(
              'Seule une vente validée (COMPLETED) ou en attente de paiement mobile money ' +
                '(AWAITING_PAYMENT) peut être annulée.',
            );
          }

          capturedWarehouseId = existing.warehouseId;

          const grouped = await this.groupDetailsByProduct(tx, existing.details);

          stockUpdates = await this.moveStock(
            tx,
            organizationId,
            existing.warehouseId,
            grouped,
            'increment',
          );

          await tx.sale.update({
            where: { id },
            data: {
              status: 'CANCELLED',
              cancelReason: reason,
              cancelledAt: new Date(),
              cancelledById: actorId,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => this.rethrowStockConflict(err));

    this.emitStockEvents(organizationId, capturedWarehouseId, stockUpdates);

    return this.prisma.sale.findUniqueOrThrow({
      where: { id },
      select: { ...SALE_SELECT, ...CLIENT_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
    });
  }

  /**
   * Retourne la liste paginée des ventes de l'organisation.
   * viewAll=false ajoute un filtre WHERE userId = userId (permission records.viewAll,
   * injectée par ViewAllInterceptor).
   */
  async findAll(
    organizationId: string,
    userId: string,
    viewAll: boolean,
    page: number,
    limit: number,
    clientId?: string,
    warehouseId?: string,
    status?: DocumentStatus,
    paymentStatus?: PaymentStatus,
  ): Promise<PaginatedResult<SaleResponse>> {
    const where: Prisma.SaleWhereInput = {
      organizationId,
      deletedAt: null,
      ...(viewAll ? {} : { userId }),
      ...(clientId ? { clientId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(status ? { status } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.sale.findMany({
        where,
        select: SALE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.sale.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  /**
   * Retourne une vente par ID avec ses lignes, son client et son entrepôt.
   * Vérifie l'ownership (anti-IDOR).
   */
  async findOne(id: string, organizationId: string): Promise<SaleResponse> {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      select: { ...SALE_SELECT, ...CLIENT_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
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
   * Envoie le récapitulatif d'une vente au client par email ou SMS (S24, §18.3 étape 4).
   * Enfile un job BullMQ ('sale.sendEmail' ou 'sale.sendSms', file 'email'/'sms') consommé
   * par un worker dédié qui recharge lui-même la vente et compose le message — cette
   * méthode ne fait aucun appel réseau synchrone (fire-and-forget, patron identique au
   * paiement mobile money POS, S22) et retourne dès que le job est enfilé.
   *
   * Aucune restriction de statut : le parcours métier (§18.3 étape 4) n'en impose aucune,
   * une vente PENDING, COMPLETED ou CANCELLED peut être partagée.
   *
   * @param id - identifiant de la vente à envoyer.
   * @param organizationId - organisation de l'utilisateur authentifié (anti-IDOR).
   * @param channel - canal d'envoi : 'email' (nécessite client.email) ou 'sms' (nécessite client.phone).
   * @returns `{ status: 'queued' }` dès que le job est enfilé (pas d'attente de l'envoi réel).
   * @throws NotFoundException si la vente est introuvable ou soft-supprimée.
   * @throws ForbiddenException si la vente n'appartient pas à l'organisation.
   * @throws BadRequestException si le client n'a pas de contact enregistré pour le canal demandé.
   */
  async send(
    id: string,
    organizationId: string,
    channel: 'email' | 'sms',
  ): Promise<{ status: 'queued' }> {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      select: { ...SALE_SELECT, ...CLIENT_WAREHOUSE_INCLUDE },
    });

    if (!sale || sale.deletedAt !== null) {
      throw new NotFoundException('Vente introuvable.');
    }
    if (sale.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    if (channel === 'email') {
      const to = sale.client.email;
      if (!to) {
        throw new BadRequestException("Ce client n'a pas d'adresse email enregistrée.");
      }
      await this.emailQueue.add('sale.sendEmail', { organizationId, saleId: id, to });
      return { status: 'queued' };
    }

    const to = sale.client.phone;
    if (!to) {
      throw new BadRequestException("Ce client n'a pas de numéro de téléphone enregistré.");
    }
    await this.smsQueue.add('sale.sendSms', { organizationId, saleId: id, to });
    return { status: 'queued' };
  }

  /**
   * Met à jour une vente PENDING : ownership re-vérifiée si clientId/warehouseId change,
   * lignes intégralement remplacées si `details` est fourni (deleteMany + createMany dans
   * la transaction), totaux recalculés côté serveur dans tous les cas.
   *
   * @throws BadRequestException si la vente n'est pas PENDING.
   * @throws NotFoundException / ForbiddenException — cf. create().
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdateSaleDto,
  ): Promise<SaleResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.sale.findUnique({
        where: { id },
        select: { ...SALE_SELECT, details: { select: DETAIL_SELECT } },
      });

      if (!existing || existing.deletedAt !== null) {
        throw new NotFoundException('Vente introuvable.');
      }
      if (existing.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }
      if (existing.status !== 'PENDING') {
        throw new BadRequestException(
          'Seule une vente en attente (PENDING) peut être modifiée.',
        );
      }

      if (dto.clientId) {
        await this.verifyClientOwnership(tx, dto.clientId, organizationId);
      }
      if (dto.warehouseId) {
        await this.verifyWarehouseOwnership(tx, dto.warehouseId, organizationId);
      }

      let sumLines: Decimal;
      if (dto.details) {
        await this.verifyDetailsOwnership(tx, dto.details, organizationId);
        const computed = dto.details.map((d) => this.computeLineTotal(d));
        sumLines = computed.reduce((acc, d) => acc.plus(d.total), new Decimal(0));

        await tx.saleDetail.deleteMany({ where: { saleId: id } });
        await tx.saleDetail.createMany({
          data: computed.map((d) => ({ saleId: id, ...this.toDetailCreateInput(d) })),
        });
      } else {
        sumLines = existing.details.reduce(
          (acc, d) => acc.plus(new Decimal(d.total)),
          new Decimal(0),
        );
      }

      const taxRate = new Decimal(dto.taxRate ?? existing.taxRate ?? '0');
      const discount = new Decimal(dto.discount ?? existing.discount ?? '0');
      const shipping = new Decimal(dto.shipping ?? existing.shipping ?? '0');
      const taxGlobal = sumLines.times(taxRate).dividedBy(100);
      const grandTotal = sumLines.plus(taxGlobal).minus(discount).plus(shipping);

      return tx.sale.update({
        where: { id },
        data: {
          clientId: dto.clientId ?? undefined,
          warehouseId: dto.warehouseId ?? undefined,
          date: dto.date ? new Date(dto.date) : undefined,
          notes: dto.notes ?? undefined,
          taxRate,
          taxAmount: taxGlobal,
          discount,
          shipping,
          grandTotal,
        },
        select: { ...SALE_SELECT, ...CLIENT_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
      });
    });
  }

  /**
   * Soft-delete d'une vente — uniquement si statut PENDING.
   * Une vente COMPLETED ou CANCELLED ne peut jamais être supprimée (§17 point 7).
   */
  async remove(id: string, organizationId: string): Promise<void> {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      select: { organizationId: true, status: true, deletedAt: true },
    });

    if (!sale || sale.deletedAt !== null) {
      throw new NotFoundException('Vente introuvable.');
    }
    if (sale.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (sale.status !== 'PENDING') {
      throw new BadRequestException(
        'Seule une vente en attente (PENDING) peut être supprimée.',
      );
    }

    await this.prisma.sale.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Regroupe les lignes d'une vente par (productId, productVariantId), en convertissant
   * chaque quantité dans l'unité de stock du produit via convertToBase si saleUnitId en
   * diffère — AVANT sommation, pour n'appliquer qu'un seul mouvement de stock cumulé par
   * couple produit/variante (jamais un appel par ligne brute, sinon la 2e ligne du même
   * produit utiliserait une version déjà obsolète après le premier adjustStock).
   * Partagé par validate() (décrément) et cancel() (restitution) — même logique de
   * regroupement/conversion, seul le sens du mouvement diffère (cf. moveStock).
   */
  private async groupDetailsByProduct(
    tx: Prisma.TransactionClient,
    details: { productId: string; productVariantId: string | null; saleUnitId: string | null; quantity: Decimal }[],
  ): Promise<Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>> {
    // Unité de stock de chaque produit référencé (pour savoir si une conversion est nécessaire).
    const productIds = [...new Set(details.map((d) => d.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, unitId: true },
    });
    const productUnitMap = new Map(products.map((p) => [p.id, p.unitId]));

    // Unit référencées par saleUnitId (operator/operatorValue pour convertToBase).
    const saleUnitIds = [
      ...new Set(details.filter((d) => d.saleUnitId).map((d) => d.saleUnitId as string)),
    ];
    const units =
      saleUnitIds.length > 0
        ? await tx.unit.findMany({
            where: { id: { in: saleUnitIds } },
            select: { id: true, operator: true, operatorValue: true },
          })
        : [];
    const unitMap = new Map(units.map((u) => [u.id, u]));

    const grouped = new Map<
      string,
      { productId: string; productVariantId: string | null; quantity: Decimal }
    >();
    for (const detail of details) {
      const productUnitId = productUnitMap.get(detail.productId) ?? null;
      let qty = new Decimal(detail.quantity);
      if (detail.saleUnitId && detail.saleUnitId !== productUnitId) {
        const unit = unitMap.get(detail.saleUnitId);
        // Défensif : ne devrait jamais être null (ownership de saleUnitId déjà vérifiée
        // à la création de la vente, S19) — NotFoundException plutôt qu'un crash TypeScript.
        if (!unit) {
          throw new NotFoundException('Unité de vente introuvable.');
        }
        qty = convertToBase(qty, unit);
      }
      const key = `${detail.productId}::${detail.productVariantId ?? ''}`;
      const g = grouped.get(key);
      if (g) {
        g.quantity = g.quantity.plus(qty);
      } else {
        grouped.set(key, {
          productId: detail.productId,
          productVariantId: detail.productVariantId,
          quantity: qty,
        });
      }
    }
    return grouped;
  }

  /**
   * Applique un mouvement de stock cumulé par (productId, productVariantId) — décrément
   * (validate, delta négatif, garde stock insuffisant AVANT adjustStock) ou restitution
   * (cancel, delta positif, aucune garde nécessaire) — sous verrouillage optimiste
   * (ProductWarehouseService.adjustStock, version + transaction Serializable déjà ouverte
   * par l'appelant).
   *
   * @throws NotFoundException si le ProductWarehouse est introuvable dans l'entrepôt.
   * @throws BadRequestException (decrement uniquement) si le stock disponible est insuffisant.
   */
  private async moveStock(
    tx: Prisma.TransactionClient,
    organizationId: string,
    warehouseId: string,
    grouped: Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>,
    direction: 'decrement' | 'increment',
  ): Promise<StockUpdate[]> {
    const stockUpdates: StockUpdate[] = [];

    for (const group of grouped.values()) {
      // Filtre product: { organizationId } : protège contre l'IDOR sur productVariantId
      // (patron identique à StockTransferService.validate).
      const pw = await tx.productWarehouse.findFirst({
        where: {
          productId: group.productId,
          warehouseId,
          productVariantId: group.productVariantId ?? null,
          product: { organizationId },
        },
        select: {
          id: true,
          version: true,
          quantity: true,
          product: { select: { stockAlert: true, name: true } },
        },
      });

      if (!pw) {
        throw new NotFoundException(
          "Stock introuvable dans l'entrepôt de la vente. " +
            'Initialisez le stock avant de valider.',
        );
      }

      if (direction === 'decrement' && group.quantity.greaterThan(pw.quantity)) {
        throw new BadRequestException(
          `Stock insuffisant pour ${pw.product.name} : ` +
            `disponible ${pw.quantity.toFixed(3)}, demandé ${group.quantity.toFixed(3)}.`,
        );
      }

      const delta = direction === 'decrement' ? group.quantity.negated() : group.quantity;

      const updated = await this.productWarehouseService.adjustStock(
        tx,
        pw.id,
        organizationId,
        delta,
        pw.version,
      );

      stockUpdates.push({
        productId: group.productId,
        newQuantity: updated.quantity,
        productName: pw.product.name,
        stockAlert: pw.product.stockAlert,
      });
    }

    return stockUpdates;
  }

  /**
   * Convertit les erreurs de concurrence de bas niveau (verrouillage optimiste,
   * sérialisation Postgres P2034) en ConflictException — patron identique pour
   * validate() et cancel().
   */
  private rethrowStockConflict(err: unknown): never {
    if (err instanceof OptimisticLockException) {
      throw new ConflictException(
        'Conflit de version sur le stock : un autre utilisateur a modifié le stock simultanément. Veuillez réessayer.',
      );
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new ConflictException('Conflit de concurrence détecté. Veuillez réessayer.');
    }
    throw err;
  }

  /**
   * Émet stock:updated (toujours) puis stock:lowAlert + notification persistée par produit
   * dont la nouvelle quantité atteint le seuil d'alerte — patron identique à
   * StockTransferService.validate, partagé par validate() et cancel().
   */
  private emitStockEvents(
    organizationId: string,
    warehouseId: string,
    stockUpdates: StockUpdate[],
  ): void {
    this.realtimeGateway.server.to(`org:${organizationId}`).emit('stock:updated', {
      warehouseId,
      products: stockUpdates.map((u) => ({ productId: u.productId, newQuantity: u.newQuantity })),
    });

    for (const update of stockUpdates) {
      if (
        update.stockAlert > 0 &&
        update.newQuantity.lessThanOrEqualTo(new Decimal(update.stockAlert))
      ) {
        this.realtimeGateway.server.to(`org:${organizationId}`).emit('stock:lowAlert', {
          productId: update.productId,
          productName: update.productName,
          currentQuantity: update.newQuantity,
          threshold: update.stockAlert,
        });
        // Persiste l'alerte pour les utilisateurs hors-ligne (§17 point I — S18)
        this.notificationService
          .createForOrg(
            organizationId,
            'stock.lowAlert',
            {
              productId: update.productId,
              productName: update.productName,
              currentQuantity: update.newQuantity.toString(),
              threshold: update.stockAlert,
              warehouseId,
            },
            'reports.quantityAlerts',
          )
          .catch((err: unknown) => {
            this.logger.error('Erreur création notification stock.lowAlert (vente)', err);
          });
      }
    }
  }

  /**
   * Calcule le total d'une ligne côté serveur :
   *   subTotal = price × quantity
   *   taxLigne = taxMethod === 'percentage' ? subTotal × (taxAmount / 100) : taxAmount
   *   remiseLigne = discountMethod === 'percentage' ? subTotal × (discount / 100) : discount
   *   total = subTotal + taxLigne − remiseLigne
   * Les champs taxAmount/discount persistés sont les valeurs d'entrée (taux ou montant
   * fixe selon la méthode), pas le résultat du calcul — seul `total` porte le résultat.
   */
  private computeLineTotal(d: SaleDetailDto): ComputedLine {
    const price = new Decimal(d.price);
    const quantity = new Decimal(d.quantity);
    const subTotal = price.times(quantity);
    const taxMethod = d.taxMethod ?? 'percentage';
    const discountMethod = d.discountMethod ?? 'percentage';
    const taxInput = new Decimal(d.taxAmount ?? '0');
    const discountInput = new Decimal(d.discount ?? '0');
    const taxLine =
      taxMethod === 'percentage' ? subTotal.times(taxInput).dividedBy(100) : taxInput;
    const discountLine =
      discountMethod === 'percentage'
        ? subTotal.times(discountInput).dividedBy(100)
        : discountInput;
    const total = subTotal.plus(taxLine).minus(discountLine);

    return {
      productId: d.productId,
      productVariantId: d.productVariantId ?? null,
      saleUnitId: d.saleUnitId ?? null,
      price,
      taxAmount: taxInput,
      taxMethod,
      discount: discountInput,
      discountMethod,
      quantity,
      total,
    };
  }

  private toDetailCreateInput(d: ComputedLine) {
    return {
      productId: d.productId,
      productVariantId: d.productVariantId,
      saleUnitId: d.saleUnitId,
      price: d.price,
      taxAmount: d.taxAmount,
      taxMethod: d.taxMethod,
      discount: d.discount,
      discountMethod: d.discountMethod,
      quantity: d.quantity,
      total: d.total,
    };
  }

  /**
   * Vérifie que le client appartient à l'organisation (anti-IDOR).
   */
  private async verifyClientOwnership(
    tx: Prisma.TransactionClient,
    clientId: string,
    organizationId: string,
  ): Promise<void> {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      select: { organizationId: true, deletedAt: true },
    });
    if (!client || client.deletedAt !== null) {
      throw new NotFoundException('Client introuvable.');
    }
    if (client.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé au client.');
    }
  }

  /**
   * Vérifie que l'entrepôt appartient à l'organisation (anti-IDOR).
   */
  private async verifyWarehouseOwnership(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    organizationId: string,
  ): Promise<void> {
    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      select: { organizationId: true, deletedAt: true },
    });
    if (!warehouse || warehouse.deletedAt !== null) {
      throw new NotFoundException('Entrepôt introuvable.');
    }
    if (warehouse.organizationId !== organizationId) {
      throw new ForbiddenException("Accès refusé à l'entrepôt.");
    }
  }

  /**
   * Vérifie l'ownership de chaque produit, variante et unité de vente référencés par
   * les lignes — DANS la transaction (anti-IDOR + anti-TOCTOU).
   */
  private async verifyDetailsOwnership(
    tx: Prisma.TransactionClient,
    details: SaleDetailDto[],
    organizationId: string,
  ): Promise<void> {
    const productIds = [...new Set(details.map((d) => d.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, organizationId: true, deletedAt: true },
    });
    for (const pid of productIds) {
      const product = products.find((p) => p.id === pid);
      if (!product || product.deletedAt !== null) {
        throw new NotFoundException('Produit introuvable.');
      }
      if (product.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }
    }

    const variantDetails = details.filter((d) => d.productVariantId);
    if (variantDetails.length > 0) {
      const variantIds = [...new Set(variantDetails.map((d) => d.productVariantId!))];
      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds }, deletedAt: null },
        select: { id: true, productId: true, product: { select: { organizationId: true } } },
      });
      for (const detail of variantDetails) {
        const variant = variants.find((v) => v.id === detail.productVariantId);
        if (!variant) {
          throw new NotFoundException('Variante introuvable.');
        }
        if (variant.productId !== detail.productId) {
          throw new ForbiddenException('Accès refusé.');
        }
        if (variant.product.organizationId !== organizationId) {
          throw new ForbiddenException('Accès refusé.');
        }
      }
    }

    const unitDetails = details.filter((d) => d.saleUnitId);
    if (unitDetails.length > 0) {
      const unitIds = [...new Set(unitDetails.map((d) => d.saleUnitId!))];
      const units = await tx.unit.findMany({
        where: { id: { in: unitIds }, deletedAt: null },
        select: { id: true, organizationId: true },
      });
      for (const detail of unitDetails) {
        const unit = units.find((u) => u.id === detail.saleUnitId);
        if (!unit) {
          throw new NotFoundException('Unité de vente introuvable.');
        }
        if (unit.organizationId !== organizationId) {
          throw new ForbiddenException('Accès refusé.');
        }
      }
    }
  }
}
