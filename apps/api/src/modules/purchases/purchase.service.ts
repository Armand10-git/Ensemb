import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentStatus, DocumentType, PaymentStatus, Prisma } from '@prisma/client';
import { convertToBase } from '@ensemb/utils';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ProductWarehouseService, OptimisticLockException } from '../inventory/product-warehouse.service';
import type { CreatePurchaseDto, PurchaseDetailDto } from './dto/create-purchase.dto';
import type { UpdatePurchaseDto } from './dto/update-purchase.dto';
import type { PaginatedResult } from '../../common/types';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface PurchaseDetailResponse {
  id: string;
  productId: string;
  productVariantId: string | null;
  purchaseUnitId: string | null;
  price: Decimal;
  taxAmount: Decimal | null;
  taxMethod: string | null;
  discount: Decimal | null;
  discountMethod: string | null;
  quantity: Decimal;
  total: Decimal;
}

export interface PurchaseResponse {
  id: string;
  organizationId: string;
  reference: string;
  date: Date;
  userId: string;
  providerId: string;
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
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  provider?: { id: string; name: string };
  warehouse?: { id: string; name: string };
  details?: PurchaseDetailResponse[];
}

/** Résultat d'un mouvement de stock appliqué par validate() — pour stock:updated. */
interface StockUpdate {
  productId: string;
  newQuantity: Decimal;
}

/** Ligne d'achat après calcul serveur — jamais confiance dans un total client (§17 point A). */
interface PurchaseDetailComputed {
  productId: string;
  productVariantId: string | null;
  purchaseUnitId: string | null;
  price: Decimal;
  taxAmount: Decimal;
  taxMethod: string;
  discount: Decimal;
  discountMethod: string;
  quantity: Decimal;
  total: Decimal;
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const PURCHASE_SELECT = {
  id: true,
  organizationId: true,
  reference: true,
  date: true,
  userId: true,
  providerId: true,
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
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DETAIL_SELECT = {
  id: true,
  productId: true,
  productVariantId: true,
  purchaseUnitId: true,
  price: true,
  taxAmount: true,
  taxMethod: true,
  discount: true,
  discountMethod: true,
  quantity: true,
  total: true,
} as const;

const PROVIDER_WAREHOUSE_INCLUDE = {
  provider: { select: { id: true, name: true } },
  warehouse: { select: { id: true, name: true } },
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des achats fournisseurs (S25 — Bloc F), mirror exact du domaine Vente
 * (S19+S20+S21 condensées pour Purchase) en sens inverse : validate() incrémente
 * le stock au lieu de le décrémenter.
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - providerId, warehouseId et chaque productId/productVariantId/purchaseUnitId
 *    vérifient l'ownership DANS la transaction avant tout accès — élimine le TOCTOU.
 *  - Tous les totaux (ligne et en-tête) sont calculés côté serveur — jamais depuis
 *    le body client (§17 point A). price/quantity/taxAmount/discount en Decimal.
 *  - Référence générée via DocumentCounterService.nextReference dans la transaction
 *    (§17 point X, DocumentType.PURCHASE, préfixe ACH).
 *  - create() ne mouvemente jamais le stock ni n'enregistre de paiement : paidAmount = 0,
 *    paymentStatus = UNPAID à la création (paiements gérés par PaymentPurchaseService,
 *    hors périmètre de cette session).
 *  - Seul un achat PENDING peut être modifié ou supprimé (§17 point 7) ; un achat
 *    COMPLETED est immuable.
 *  - Le taux de TVA d'en-tête (taxRate) est toujours un pourcentage. La remise d'en-tête
 *    (discount) est toujours un montant XAF fixe soustrait du total, sans mode pourcentage.
 *  - validate() est la seule action qui mouvemente le stock d'un achat : incrément de
 *    ProductWarehouse via ProductWarehouseService.adjustStock (verrouillage optimiste,
 *    transaction Serializable), conversion d'unité purchaseUnitId → unité de stock du
 *    produit via convertToBase. Contrairement à une vente, un incrément ne peut jamais
 *    échouer pour cause de stock insuffisant, et l'absence de ProductWarehouse déclenche
 *    sa création (la première réception EST ce qui crée le stock) plutôt qu'une erreur.
 *  - Pas de cancel() dans cette session : purchases.cancel existe en permission mais
 *    aucune session ne l'implémente encore (écart assumé, à signaler en fin de plan).
 */
@Injectable()
export class PurchaseService {
  private readonly logger = new Logger(PurchaseService.name);

  /**
   * Nombre maximal de tentatives de validate() en cas de conflit de concurrence
   * (OptimisticLockException / Prisma P2034) sur le ProductWarehouse cible. Un incrément
   * de stock étant toujours fusionnable (cf. JSDoc de validate()), on retente au lieu de
   * remonter un 409 dès le premier conflit — au-delà de ce plafond (beaucoup plus de 2
   * écrivains simultanés que ce que la session exerce en pratique), on abandonne et on
   * remonte ConflictException comme le ferait SaleService.validate() sans retry.
   */
  private static readonly MAX_VALIDATE_ATTEMPTS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly productWarehouseService: ProductWarehouseService,
  ) {}

  /**
   * Crée un achat en statut PENDING avec ses lignes dans une transaction.
   * Référence générée via DocumentCounterService.nextReference. Émet purchase:created
   * vers org:{organizationId}.
   *
   * @throws NotFoundException si le fournisseur, l'entrepôt, un produit, une variante ou
   *         une unité d'achat est introuvable.
   * @throws ForbiddenException si l'une de ces ressources n'appartient pas à l'organisation.
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreatePurchaseDto,
  ): Promise<PurchaseResponse> {
    const purchase = await this.prisma.$transaction(async (tx) => {
      await this.verifyProviderOwnership(tx, dto.providerId, organizationId);
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
        DocumentType.PURCHASE,
      );

      return tx.purchase.create({
        data: {
          organizationId,
          reference,
          date: new Date(dto.date),
          userId,
          providerId: dto.providerId,
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
        select: {
          ...PURCHASE_SELECT,
          ...PROVIDER_WAREHOUSE_INCLUDE,
          details: { select: DETAIL_SELECT },
        },
      });
    });

    this.realtimeGateway.server.to(`org:${organizationId}`).emit('purchase:created', {
      organizationId,
      purchaseId: purchase.id,
      warehouseId: purchase.warehouseId,
      grandTotal: purchase.grandTotal,
    });

    return purchase;
  }

  /**
   * Valide un achat PENDING : incrémente le stock de l'entrepôt de l'achat pour
   * chaque ligne (regroupées par couple produit/variante, converties dans l'unité de
   * stock du produit via convertToBase si purchaseUnitId diffère), puis fait passer le
   * statut à COMPLETED — le tout dans une seule transaction Serializable.
   *
   * Indépendant de paymentStatus/PaymentPurchase : un achat peut être validé (stock
   * mouvementé) sans être payé — le paiement suit son propre cycle.
   *
   * L'achat et ses lignes sont relus DANS la transaction Serializable pour éliminer
   * le TOCTOU : deux requêtes concurrentes de validation sur le même achat ne peuvent
   * pas toutes deux passer le contrôle PENDING et double-incrémenter le stock. Les
   * lignes sont regroupées par (productId, productVariantId) et sommées AVANT tout
   * appel à adjustStock — un seul mouvement cumulé par couple produit/variante.
   *
   * Contrairement à une vente, un incrément ne peut jamais échouer pour cause de stock
   * insuffisant (aucune garde de ce type), et l'absence de ProductWarehouse déclenche sa
   * création plutôt qu'une NotFoundException — cf. moveStock().
   *
   * ÉCART ASSUMÉ vs SaleService.validate() (documenté, pas un oubli) : cette méthode retente
   * automatiquement (jusqu'à MAX_VALIDATE_ATTEMPTS tentatives) sur un conflit de concurrence
   * (OptimisticLockException ou Prisma P2034), alors que SaleService.validate() ne retente
   * jamais et remonte le conflit tel quel (409) dès la première occurrence. La raison est
   * strictement métier, pas technique : un incrément de stock (achat) est commutatif et
   * toujours fusionnable — deux réceptions concurrentes de +5 et +7 ont pour seul résultat
   * correct +12, quel que soit l'ordre d'application, et aucune décision humaine n'est
   * requise entre les deux tentatives. Un décrément de stock (vente) ne l'est pas : l'échec
   * d'une seconde tentative peut signifier que le stock est désormais insuffisant, ce qui EST
   * une information métier (« dernier exemplaire déjà vendu ») qu'un retry aveugle masquerait
   * en la transformant silencieusement en une resynchronisation. Retenter une vente romprait
   * l'invariant « jamais de stock négatif » sans le vouloir. Retenter un achat ne rompt rien :
   * dans le pire cas (MAX_VALIDATE_ATTEMPTS tentatives toutes en conflit — beaucoup plus de 2
   * écrivains simultanés que ce que le test de concurrence exerce), on retombe sur le même
   * ConflictException 409 que SaleService, en dernier recours.
   *
   * @throws NotFoundException si l'achat ou une unité d'achat référencée est introuvable.
   * @throws ForbiddenException si l'achat n'appartient pas à l'organisation.
   * @throws BadRequestException si l'achat n'est pas PENDING, ou si une ligne produit un
   *         delta de stock nul/négatif/non fini après conversion d'unité (cf. moveStock).
   * @throws ConflictException si un conflit de version optimiste ou de sérialisation (P2034)
   *         persiste après MAX_VALIDATE_ATTEMPTS tentatives.
   */
  async validate(id: string, organizationId: string): Promise<PurchaseResponse> {
    let stockUpdates: StockUpdate[] = [];
    let capturedWarehouseId!: string;

    for (let attempt = 1; attempt <= PurchaseService.MAX_VALIDATE_ATTEMPTS; attempt++) {
      stockUpdates = [];
      try {
        await this.prisma.$transaction(
          async (tx) => {
            // 1. Relire l'achat + lignes DANS la transaction Serializable (élimine le TOCTOU).
            const existing = await tx.purchase.findUnique({
              where: { id },
              select: { ...PURCHASE_SELECT, details: { select: DETAIL_SELECT } },
            });

            if (!existing || existing.deletedAt !== null) {
              throw new NotFoundException('Achat introuvable.');
            }
            if (existing.organizationId !== organizationId) {
              throw new ForbiddenException('Accès refusé.');
            }
            if (existing.status !== 'PENDING') {
              throw new BadRequestException(
                'Seul un achat en attente (PENDING) peut être validé.',
              );
            }

            capturedWarehouseId = existing.warehouseId;

            // 2-4. Regroupement par (productId, productVariantId) avec conversion d'unité.
            const grouped = await this.groupDetailsByProduct(tx, existing.details);

            // 5. Incrément (création du ProductWarehouse si absent, aucune garde stock insuffisant).
            stockUpdates = await this.moveStock(tx, organizationId, existing.warehouseId, grouped);

            // 6. Statut
            await tx.purchase.update({ where: { id }, data: { status: 'COMPLETED' } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break; // succès — sort de la boucle de retry
      } catch (err) {
        const isConcurrencyConflict =
          err instanceof OptimisticLockException ||
          (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034');

        if (isConcurrencyConflict && attempt < PurchaseService.MAX_VALIDATE_ATTEMPTS) {
          // Un incrément est toujours fusionnable — aucune décision métier perdue en retentant.
          continue;
        }
        // Dernière tentative épuisée (conflit persistant), ou erreur non liée à la concurrence
        // (NotFoundException/ForbiddenException/BadRequestException) : relancée immédiatement,
        // sans consommer de tentative supplémentaire pour ces dernières.
        this.rethrowStockConflict(err);
      }
    }

    this.emitStockEvents(organizationId, capturedWarehouseId, stockUpdates);

    return this.prisma.purchase.findUniqueOrThrow({
      where: { id },
      select: {
        ...PURCHASE_SELECT,
        ...PROVIDER_WAREHOUSE_INCLUDE,
        details: { select: DETAIL_SELECT },
      },
    });
  }

  /**
   * Retourne la liste paginée des achats de l'organisation.
   * viewAll=false ajoute un filtre WHERE userId = userId (permission records.viewAll,
   * injectée par ViewAllInterceptor).
   */
  async findAll(
    organizationId: string,
    userId: string,
    viewAll: boolean,
    page: number,
    limit: number,
    providerId?: string,
    warehouseId?: string,
    status?: DocumentStatus,
    paymentStatus?: PaymentStatus,
  ): Promise<PaginatedResult<PurchaseResponse>> {
    const where: Prisma.PurchaseWhereInput = {
      organizationId,
      deletedAt: null,
      ...(viewAll ? {} : { userId }),
      ...(providerId ? { providerId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(status ? { status } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        where,
        select: PURCHASE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  /**
   * Retourne un achat par ID avec ses lignes, son fournisseur et son entrepôt.
   * Vérifie l'ownership (anti-IDOR).
   */
  async findOne(id: string, organizationId: string): Promise<PurchaseResponse> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      select: {
        ...PURCHASE_SELECT,
        ...PROVIDER_WAREHOUSE_INCLUDE,
        details: { select: DETAIL_SELECT },
      },
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
   * Met à jour un achat PENDING : ownership re-vérifiée si providerId/warehouseId change,
   * lignes intégralement remplacées si `details` est fourni (deleteMany + createMany dans
   * la transaction), totaux recalculés côté serveur dans tous les cas.
   *
   * @throws BadRequestException si l'achat n'est pas PENDING.
   * @throws NotFoundException / ForbiddenException — cf. create().
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdatePurchaseDto,
  ): Promise<PurchaseResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.purchase.findUnique({
        where: { id },
        select: { ...PURCHASE_SELECT, details: { select: DETAIL_SELECT } },
      });

      if (!existing || existing.deletedAt !== null) {
        throw new NotFoundException('Achat introuvable.');
      }
      if (existing.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }
      if (existing.status !== 'PENDING') {
        throw new BadRequestException(
          'Seul un achat en attente (PENDING) peut être modifié.',
        );
      }

      if (dto.providerId) {
        await this.verifyProviderOwnership(tx, dto.providerId, organizationId);
      }
      if (dto.warehouseId) {
        await this.verifyWarehouseOwnership(tx, dto.warehouseId, organizationId);
      }

      let sumLines: Decimal;
      if (dto.details) {
        await this.verifyDetailsOwnership(tx, dto.details, organizationId);
        const computed = dto.details.map((d) => this.computeLineTotal(d));
        sumLines = computed.reduce((acc, d) => acc.plus(d.total), new Decimal(0));

        await tx.purchaseDetail.deleteMany({ where: { purchaseId: id } });
        await tx.purchaseDetail.createMany({
          data: computed.map((d) => ({ purchaseId: id, ...this.toDetailCreateInput(d) })),
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

      return tx.purchase.update({
        where: { id },
        data: {
          providerId: dto.providerId ?? undefined,
          warehouseId: dto.warehouseId ?? undefined,
          date: dto.date ? new Date(dto.date) : undefined,
          notes: dto.notes ?? undefined,
          taxRate,
          taxAmount: taxGlobal,
          discount,
          shipping,
          grandTotal,
        },
        select: {
          ...PURCHASE_SELECT,
          ...PROVIDER_WAREHOUSE_INCLUDE,
          details: { select: DETAIL_SELECT },
        },
      });
    });
  }

  /**
   * Soft-delete d'un achat — uniquement si statut PENDING.
   * Un achat COMPLETED ne peut jamais être supprimé (§17 point 7).
   */
  async remove(id: string, organizationId: string): Promise<void> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      select: { organizationId: true, status: true, deletedAt: true },
    });

    if (!purchase || purchase.deletedAt !== null) {
      throw new NotFoundException('Achat introuvable.');
    }
    if (purchase.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (purchase.status !== 'PENDING') {
      throw new BadRequestException(
        'Seul un achat en attente (PENDING) peut être supprimé.',
      );
    }

    await this.prisma.purchase.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Regroupe les lignes d'un achat par (productId, productVariantId), en convertissant
   * chaque quantité dans l'unité de stock du produit via convertToBase si purchaseUnitId
   * en diffère — AVANT sommation, pour n'appliquer qu'un seul mouvement de stock cumulé
   * par couple produit/variante (jamais un appel par ligne brute, sinon la 2e ligne du
   * même produit utiliserait une version déjà obsolète après le premier adjustStock).
   */
  private async groupDetailsByProduct(
    tx: Prisma.TransactionClient,
    details: {
      productId: string;
      productVariantId: string | null;
      purchaseUnitId: string | null;
      quantity: Decimal;
    }[],
  ): Promise<Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>> {
    // Unité de stock de chaque produit référencé (pour savoir si une conversion est nécessaire).
    const productIds = [...new Set(details.map((d) => d.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, unitId: true },
    });
    const productUnitMap = new Map(products.map((p) => [p.id, p.unitId]));

    // Unit référencées par purchaseUnitId (operator/operatorValue pour convertToBase).
    const purchaseUnitIds = [
      ...new Set(details.filter((d) => d.purchaseUnitId).map((d) => d.purchaseUnitId as string)),
    ];
    const units =
      purchaseUnitIds.length > 0
        ? await tx.unit.findMany({
            where: { id: { in: purchaseUnitIds } },
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
      if (detail.purchaseUnitId && detail.purchaseUnitId !== productUnitId) {
        const unit = unitMap.get(detail.purchaseUnitId);
        // Défensif : ne devrait jamais être null (ownership de purchaseUnitId déjà vérifiée
        // à la création de l'achat) — NotFoundException plutôt qu'un crash TypeScript.
        if (!unit) {
          throw new NotFoundException("Unité d'achat introuvable.");
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
   * Applique un incrément de stock cumulé par (productId, productVariantId) sous
   * verrouillage optimiste (ProductWarehouseService.adjustStock, version + transaction
   * Serializable déjà ouverte par l'appelant).
   *
   * Aucune garde stock insuffisant — un incrément ne peut jamais échouer pour ce motif
   * (contrairement à SaleService.moveStock qui décrémente). En revanche, chaque delta est
   * vérifié fini et strictement positif avant tout accès (cf. garde ci-dessous) — une Unit
   * mal configurée ne doit jamais produire un incrément silencieusement nul ou infini.
   *
   * Si la ligne ProductWarehouse n'existe pas encore pour ce (produit, entrepôt, variante),
   * elle est créée ICI, DANS LA MÊME TRANSACTION Serializable, avec quantity=0/version=0,
   * puis immédiatement incrémentée via adjustStock(version attendue 0) — pour un achat,
   * la première réception d'un produit dans un entrepôt EST ce qui crée le stock (à
   * l'inverse d'une vente, où l'absence de ProductWarehouse est une erreur bloquante).
   * On n'appelle volontairement PAS ProductWarehouseService.initStock() : cette méthode
   * ouvre sa propre transaction via this.prisma, non composable avec la transaction
   * Serializable déjà ouverte par validate() — une transaction imbriquée romprait
   * l'atomicité et exposerait un TOCTOU entre la création et l'incrément.
   *
   * @throws ForbiddenException si le ProductWarehouse trouvé n'appartient pas à
   *         organizationId (relayé par adjustStock).
   * @throws BadRequestException si la quantité convertie est nulle, négative ou non finie
   *         (Unit mal configurée — operatorValue à 0 notamment).
   */
  private async moveStock(
    tx: Prisma.TransactionClient,
    organizationId: string,
    warehouseId: string,
    grouped: Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>,
  ): Promise<StockUpdate[]> {
    const stockUpdates: StockUpdate[] = [];

    for (const group of grouped.values()) {
      // Garde de cohérence (§17 point A) : une Unit mal configurée (operatorValue "0" —
      // accepté par CreateUnitSchema qui n'exige qu'un décimal non négatif, pas strictement
      // positif) ferait produire à convertToBase soit 0 (operator "*", incrément silencieux
      // nul — stock reçu non comptabilisé) soit +Infinity (operator "/", division par zéro
      // — Decimal ne lève pas d'exception, cf. decimal.js). Un incrément d'achat doit
      // toujours être fini et strictement positif ; on ne fait jamais confiance implicitement
      // à la conversion d'unité en amont.
      if (!group.quantity.isFinite() || group.quantity.lessThanOrEqualTo(0)) {
        throw new BadRequestException(
          "Quantité invalide après conversion d'unité — vérifiez la configuration de l'unité d'achat utilisée.",
        );
      }

      // Filtre product: { organizationId } : protège contre l'IDOR sur productVariantId
      // (patron identique à SaleService.moveStock).
      const pw = await tx.productWarehouse.findFirst({
        where: {
          productId: group.productId,
          warehouseId,
          productVariantId: group.productVariantId ?? null,
          product: { organizationId },
        },
        select: { id: true, version: true },
      });

      let productWarehouseId: string;
      let expectedVersion: number;

      if (pw) {
        productWarehouseId = pw.id;
        expectedVersion = pw.version;
      } else {
        // Première réception : crée la ligne de stock à zéro dans la transaction en cours.
        const created = await tx.productWarehouse.create({
          data: {
            productId: group.productId,
            warehouseId,
            productVariantId: group.productVariantId ?? null,
            quantity: new Decimal(0),
            version: 0,
          },
          select: { id: true, version: true },
        });
        productWarehouseId = created.id;
        expectedVersion = created.version;
      }

      const updated = await this.productWarehouseService.adjustStock(
        tx,
        productWarehouseId,
        organizationId,
        group.quantity,
        expectedVersion,
      );

      stockUpdates.push({
        productId: group.productId,
        newQuantity: updated.quantity,
      });
    }

    return stockUpdates;
  }

  /**
   * Convertit les erreurs de concurrence de bas niveau (verrouillage optimiste,
   * sérialisation Postgres P2034) en ConflictException.
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
   * Émet stock:updated vers org:{organizationId} — pas de stock:lowAlert ici (n'a de
   * sens qu'à la baisse du stock, jamais à la hausse d'un achat).
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
  private computeLineTotal(d: PurchaseDetailDto): PurchaseDetailComputed {
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
      purchaseUnitId: d.purchaseUnitId ?? null,
      price,
      taxAmount: taxInput,
      taxMethod,
      discount: discountInput,
      discountMethod,
      quantity,
      total,
    };
  }

  private toDetailCreateInput(d: PurchaseDetailComputed) {
    return {
      productId: d.productId,
      productVariantId: d.productVariantId,
      purchaseUnitId: d.purchaseUnitId,
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
   * Vérifie que le fournisseur appartient à l'organisation (anti-IDOR).
   */
  private async verifyProviderOwnership(
    tx: Prisma.TransactionClient,
    providerId: string,
    organizationId: string,
  ): Promise<void> {
    const provider = await tx.provider.findUnique({
      where: { id: providerId },
      select: { organizationId: true, deletedAt: true },
    });
    if (!provider || provider.deletedAt !== null) {
      throw new NotFoundException('Fournisseur introuvable.');
    }
    if (provider.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé au fournisseur.');
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
   * Vérifie l'ownership de chaque produit, variante et unité d'achat référencés par
   * les lignes — DANS la transaction (anti-IDOR + anti-TOCTOU).
   */
  private async verifyDetailsOwnership(
    tx: Prisma.TransactionClient,
    details: PurchaseDetailDto[],
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

    const unitDetails = details.filter((d) => d.purchaseUnitId);
    if (unitDetails.length > 0) {
      const unitIds = [...new Set(unitDetails.map((d) => d.purchaseUnitId!))];
      const units = await tx.unit.findMany({
        where: { id: { in: unitIds }, deletedAt: null },
        select: { id: true, organizationId: true },
      });
      for (const detail of unitDetails) {
        const unit = units.find((u) => u.id === detail.purchaseUnitId);
        if (!unit) {
          throw new NotFoundException("Unité d'achat introuvable.");
        }
        if (unit.organizationId !== organizationId) {
          throw new ForbiddenException('Accès refusé.');
        }
      }
    }
  }
}
