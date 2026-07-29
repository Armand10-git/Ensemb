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
import { ConfigService } from '@nestjs/config';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentStatus, DocumentType, PaymentMethod, Prisma } from '@prisma/client';
import { convertToBase } from '@ensemb/utils';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  ProductWarehouseService,
  OptimisticLockException,
} from '../inventory/product-warehouse.service';
import { NotificationService } from '../notifications/notification.service';
import { PaymentSaleService } from '../sales/payment-sale.service';
import { PaymentAggregatorService } from '../billing/payment-aggregator.service';
import { CashSessionService } from '../cash-sessions/cash-session.service';
import type { SaleResponse } from '../sales/sale.service';
import type { CalculateTotalDto, CreatePosSaleDto, PosLineDto } from './dto/pos-sale.dto';

const DEFAULT_POS_PAYMENT_TIMEOUT_MS = 180_000; // 3 minutes (§18.2 étape 10)

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProductSearchResult {
  id: string;
  code: string;
  name: string;
  price: Decimal;
  taxRate: Decimal;
  taxMethod: string;
  unitId: string | null;
  unitSaleId: string | null;
  /** Quantité en stock LIVE dans l'entrepôt demandé (0 si aucun ProductWarehouse). */
  quantity: Decimal;
}

interface ComputedPosLine {
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

export interface CalculatedTotal {
  details: ComputedPosLine[];
  sumLines: Decimal;
  taxAmount: Decimal;
  discount: Decimal;
  shipping: Decimal;
  grandTotal: Decimal;
}

interface StockUpdate {
  productId: string;
  newQuantity: Decimal;
  productName: string;
  stockAlert: number;
}

export interface PosSaleResponse extends SaleResponse {
  /** Lien de paiement mobile money — présent uniquement si paymentMethod === MOBILE_MONEY. */
  paymentLink?: string;
}

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

/**
 * Module POS (S22 — Bloc E, §18.2) : recherche produit, calcul de total serveur et
 * création atomique d'une vente au comptoir (création + décrément de stock + paiement
 * immédiat en une seule transaction, contrairement à la vente classique S19/S21 qui
 * sépare create() et validate()).
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - Le total est TOUJOURS recalculé côté serveur (calculateTotal, fonction pure) — jamais
 *    depuis un total envoyé par le client, à la fois pour la prévisualisation
 *    (calculate-total) et pour la création réelle (createSale), qui appellent
 *    exactement la même formule (§18.2 étape 6 — recalcul indépendant du client).
 *  - CASH/CARD : PaymentSale créé immédiatement via PaymentSaleService.createInTransaction
 *    (réutilisé, pas de duplication du calcul paidAmount/paymentStatus), status COMPLETED.
 *  - MOBILE_MONEY : status AWAITING_PAYMENT, stock déjà décrémenté (réservé), aucun
 *    PaymentSale créé — lien de paiement généré après la transaction, job d'expiration
 *    différé enfilé (queue pos-payment-expiration, §17 point V).
 *  - Session de caisse obligatoire (S23b) : createSale() exige une session CashSession OPEN
 *    pour (organizationId, userId, dto.warehouseId) — vérifiée et rattachée (cashSessionId)
 *    DANS la même transaction Serializable que la création de la vente, via
 *    CashSessionService.findOpenSessionInTransaction, pour éliminer tout TOCTOU avec une
 *    clôture de session concurrente (§18.2).
 */
@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly productWarehouseService: ProductWarehouseService,
    private readonly notificationService: NotificationService,
    private readonly paymentSaleService: PaymentSaleService,
    private readonly aggregator: PaymentAggregatorService,
    private readonly cashSessionService: CashSessionService,
    private readonly config: ConfigService,
    @InjectQueue('pos-payment-expiration')
    private readonly expirationQueue: Queue<{ saleId: string; organizationId: string }>,
  ) {}

  /**
   * GET /pos/products/search — recherche par nom (partiel, insensible à la casse) ou
   * code (le scanner tape le code dans le même champ recherche, §17 point D — pas
   * d'endpoint /scan séparé). Retourne la quantité en stock LIVE dans l'entrepôt demandé.
   *
   * @throws NotFoundException si l'entrepôt est introuvable.
   * @throws ForbiddenException si l'entrepôt n'appartient pas à l'organisation.
   */
  async searchProducts(
    organizationId: string,
    warehouseId: string,
    q?: string,
  ): Promise<ProductSearchResult[]> {
    await this.verifyWarehouseOwnership(this.prisma, warehouseId, organizationId);

    const rows = await this.prisma.product.findMany({
      where: {
        organizationId,
        deletedAt: null,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { code: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        code: true,
        name: true,
        price: true,
        taxRate: true,
        taxMethod: true,
        unitId: true,
        unitSaleId: true,
        stocks: {
          where: { warehouseId, productVariantId: null },
          select: { quantity: true },
        },
      },
      orderBy: { name: 'asc' },
      take: 25,
    });

    return rows.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      price: p.price,
      taxRate: p.taxRate,
      taxMethod: p.taxMethod,
      unitId: p.unitId,
      unitSaleId: p.unitSaleId,
      quantity: p.stocks[0]?.quantity ?? new Decimal(0),
    }));
  }

  /**
   * POST /pos/calculate-total — recalcule le total côté serveur, ne persiste rien.
   * Appelle exactement la même formule que createSale() (cf. classe JSDoc) — jamais deux
   * implémentations qui pourraient diverger.
   */
  calculateTotal(dto: CalculateTotalDto): CalculatedTotal {
    return this.computeTotal(dto.details, dto.taxRate, dto.discount, dto.shipping);
  }

  /**
   * POST /pos/sales — crée une vente POS en une seule transaction Serializable : recalcule
   * le total serveur (ignore tout total envoyé par le client), vérifie et décrémente le stock
   * sous verrouillage optimiste, crée Sale (isPos: true) + SaleDetail[], puis :
   *  - CASH/CARD : encaisse immédiatement (PaymentSale, status COMPLETED)
   *  - MOBILE_MONEY : status AWAITING_PAYMENT, lien de paiement généré et job d'expiration
   *    enfilé APRÈS le commit (pas d'appel réseau à l'intérieur de la transaction).
   *
   * Exige une session de caisse OPEN (§18.2, S23b) pour (organizationId, userId,
   * dto.warehouseId) : recherchée via CashSessionService.findOpenSessionInTransaction juste
   * après verifyWarehouseOwnership — dans la même transaction Serializable, donc sans TOCTOU
   * possible avec une clôture concurrente — et rattachée à la vente créée (cashSessionId).
   *
   * @throws NotFoundException / ForbiddenException si client/entrepôt/produit hors organisation.
   * @throws BadRequestException si le stock est insuffisant, si amountReceived < grandTotal (CASH),
   *         ou si aucune session de caisse n'est ouverte pour cet entrepôt.
   * @throws ConflictException si un conflit de version optimiste ou de sérialisation (P2034).
   */
  async createSale(
    organizationId: string,
    userId: string,
    dto: CreatePosSaleDto,
  ): Promise<PosSaleResponse> {
    const totals = this.computeTotal(dto.details, dto.taxRate, dto.discount, dto.shipping);

    let stockUpdates: StockUpdate[] = [];

    const sale = await this.prisma
      .$transaction(
        async (tx) => {
          await this.verifyClientOwnership(tx, dto.clientId, organizationId);
          await this.verifyWarehouseOwnership(tx, dto.warehouseId, organizationId);

          // Session de caisse obligatoire (S23b) : vérifiée ici, juste après l'ownership de
          // l'entrepôt (dont dépend la recherche) et avant verifyDetailsOwnership — échec
          // rapide sur la précondition métier la moins coûteuse avant de valider chaque ligne
          // produit/variante/unité. Même transaction Serializable que la création de la vente
          // => pas de TOCTOU avec une clôture de session concurrente.
          const cashSession = await this.cashSessionService.findOpenSessionInTransaction(
            tx,
            organizationId,
            userId,
            dto.warehouseId,
          );
          if (!cashSession) {
            throw new BadRequestException(
              "Aucune session de caisse ouverte pour cet entrepôt — ouvrez une session avant d'encaisser.",
            );
          }

          await this.verifyDetailsOwnership(tx, dto.details, organizationId);

          const grouped = await this.groupDetailsByProduct(tx, totals.details);
          stockUpdates = await this.decrementStock(tx, organizationId, dto.warehouseId, grouped);

          const reference = await this.documentCounter.nextReference(
            tx,
            organizationId,
            DocumentType.SALE,
          );

          const status: DocumentStatus =
            dto.paymentMethod === 'MOBILE_MONEY' ? 'AWAITING_PAYMENT' : 'COMPLETED';

          const created = await tx.sale.create({
            data: {
              organizationId,
              reference,
              date: dto.date ? new Date(dto.date) : new Date(),
              isPos: true,
              userId,
              clientId: dto.clientId,
              warehouseId: dto.warehouseId,
              cashSessionId: cashSession.id,
              taxRate: new Decimal(dto.taxRate ?? '0'),
              taxAmount: totals.taxAmount,
              discount: totals.discount,
              shipping: totals.shipping,
              grandTotal: totals.grandTotal,
              paidAmount: new Decimal(0),
              paymentStatus: 'UNPAID',
              status,
              notes: dto.notes,
              details: { create: totals.details.map((d) => this.toDetailCreateInput(d)) },
            },
            select: { ...SALE_SELECT, details: { select: DETAIL_SELECT } },
          });

          if (dto.paymentMethod === 'CASH' || dto.paymentMethod === 'CARD') {
            const change =
              dto.paymentMethod === 'CASH'
                ? new Decimal(dto.amountReceived ?? '0').minus(totals.grandTotal)
                : new Decimal(0);

            if (change.isNegative()) {
              throw new BadRequestException(
                `Montant reçu insuffisant : total ${totals.grandTotal.toFixed(3)}, ` +
                  `reçu ${dto.amountReceived ?? '0'}.`,
              );
            }

            await this.paymentSaleService.createInTransaction(
              tx,
              organizationId,
              userId,
              created.id,
              {
                date: created.date.toISOString(),
                amount: totals.grandTotal.toString(),
                method: dto.paymentMethod as PaymentMethod,
                change: change.toString(),
              },
            );
          }

          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => this.rethrowStockConflict(err));

    this.emitStockEvents(organizationId, dto.warehouseId, stockUpdates);
    this.realtimeGateway.server.to(`org:${organizationId}`).emit('sale:created', {
      organizationId,
      saleId: sale.id,
      warehouseId: sale.warehouseId,
      grandTotal: sale.grandTotal,
    });

    const fullSale = await this.prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { ...SALE_SELECT, details: { select: DETAIL_SELECT } },
    });

    if (dto.paymentMethod !== 'MOBILE_MONEY') {
      return fullSale;
    }

    // Appel réseau + enqueue APRÈS le commit — jamais à l'intérieur de la transaction.
    const paymentLink = await this.generateMobileMoneyLink(organizationId, fullSale);
    const timeoutMs = Number(
      this.config.get<string>('POS_PAYMENT_TIMEOUT_MS') ?? DEFAULT_POS_PAYMENT_TIMEOUT_MS,
    );
    await this.expirationQueue.add(
      'pos.expirePayment',
      { saleId: fullSale.id, organizationId },
      { delay: timeoutMs },
    );

    return { ...fullSale, paymentLink };
  }

  /**
   * Confirme le paiement mobile money d'une vente POS (appelée par le webhook de
   * l'agrégateur, idempotent via WebhookEvent en amont). Repasse la vente
   * AWAITING_PAYMENT → COMPLETED et crée le PaymentSale correspondant — le stock,
   * déjà décrémenté à la création, n'est PAS retouché.
   *
   * No-op idempotent (jamais d'exception) si la vente n'est plus AWAITING_PAYMENT
   * (déjà expirée ou déjà confirmée) ou si elle n'appartient pas à l'organisation —
   * un webhook ne doit jamais faire échouer la réponse HTTP à l'agrégateur.
   */
  async confirmMobileMoneyPayment(organizationId: string, saleId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({
        where: { id: saleId },
        select: { organizationId: true, status: true, grandTotal: true, date: true, userId: true },
      });

      if (!sale || sale.organizationId !== organizationId) {
        this.logger.warn(`confirmMobileMoneyPayment : vente ${saleId} introuvable ou hors org — ignoré`);
        return;
      }
      if (sale.status !== 'AWAITING_PAYMENT') {
        this.logger.log(`confirmMobileMoneyPayment : vente ${saleId} déjà ${sale.status} — no-op idempotent`);
        return;
      }

      await tx.sale.update({ where: { id: saleId }, data: { status: 'COMPLETED' } });

      await this.paymentSaleService.createInTransaction(tx, organizationId, sale.userId, saleId, {
        date: sale.date.toISOString(),
        amount: sale.grandTotal.toString(),
        method: 'MOBILE_MONEY',
        change: '0',
      });
    });

    this.realtimeGateway.server.to(`org:${organizationId}`).emit('sale:updated', { saleId });
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Génère le lien de paiement mobile money via PaymentAggregatorService (réutilisé tel
   * quel, pas de duplication HMAC/appel réseau) — la référence transmise est l'UUID de la
   * vente : le webhook de l'agrégateur (handlePosPaymentWebhook) l'échote sous le champ
   * `saleId` du payload pour résoudre la vente sans ambiguïté (même patron que
   * BillingService/invoiceId).
   */
  private async generateMobileMoneyLink(organizationId: string, sale: SaleResponse): Promise<string> {
    const base =
      this.config.get<string>('POS_PAYMENT_CALLBACK_BASE_URL') ??
      'http://localhost:3000/api/v1/webhooks/payments';
    return this.aggregator.generatePaymentLink({
      amount: sale.grandTotal,
      currency: 'XAF',
      reference: sale.id,
      callbackUrl: `${base}/${organizationId}`,
    });
  }

  /**
   * Calcule chaque ligne (même formule que SaleService.computeLineTotal, S19) puis le total
   * d'en-tête — fonction pure, aucun accès DB, appelée par calculateTotal() ET createSale()
   * pour garantir qu'elles ne peuvent jamais diverger (§18.2 étape 6).
   */
  private computeTotal(
    details: PosLineDto[],
    taxRate?: string,
    discount?: string,
    shipping?: string,
  ): CalculatedTotal {
    const computed = details.map((d) => this.computeLineTotal(d));
    const sumLines = computed.reduce((acc, d) => acc.plus(d.total), new Decimal(0));

    const taxRateDec = new Decimal(taxRate ?? '0');
    const discountDec = new Decimal(discount ?? '0');
    const shippingDec = new Decimal(shipping ?? '0');
    const taxGlobal = sumLines.times(taxRateDec).dividedBy(100);
    const grandTotal = sumLines.plus(taxGlobal).minus(discountDec).plus(shippingDec);

    return {
      details: computed,
      sumLines,
      taxAmount: taxGlobal,
      discount: discountDec,
      shipping: shippingDec,
      grandTotal,
    };
  }

  private computeLineTotal(d: PosLineDto): ComputedPosLine {
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

  private toDetailCreateInput(d: ComputedPosLine) {
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
   * Regroupe les lignes par (productId, productVariantId) avec conversion d'unité — même
   * patron que SaleService.groupDetailsByProduct (S21), dupliqué ici car PosService ne
   * dépend pas de SalesModule (frontière de module claire, pas d'import croisé).
   */
  private async groupDetailsByProduct(
    tx: Prisma.TransactionClient,
    details: ComputedPosLine[],
  ): Promise<Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>> {
    const productIds = [...new Set(details.map((d) => d.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, unitId: true },
    });
    const productUnitMap = new Map(products.map((p) => [p.id, p.unitId]));

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
      let qty = detail.quantity;
      if (detail.saleUnitId && detail.saleUnitId !== productUnitId) {
        const unit = unitMap.get(detail.saleUnitId);
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
   * Décrémente le stock sous verrouillage optimiste — garde stock insuffisant AVANT
   * adjustStock, message d'erreur exact du parcours §18.2 étape 9 ("stock insuffisant,
   * quantité disponible : X"), jamais une 500.
   */
  private async decrementStock(
    tx: Prisma.TransactionClient,
    organizationId: string,
    warehouseId: string,
    grouped: Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>,
  ): Promise<StockUpdate[]> {
    const stockUpdates: StockUpdate[] = [];

    for (const group of grouped.values()) {
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
          "Stock introuvable dans l'entrepôt sélectionné. Initialisez le stock avant la vente.",
        );
      }

      if (group.quantity.greaterThan(pw.quantity)) {
        throw new BadRequestException(
          `Stock insuffisant pour ${pw.product.name} : quantité disponible ${pw.quantity.toFixed(3)}.`,
        );
      }

      const updated = await this.productWarehouseService.adjustStock(
        tx,
        pw.id,
        organizationId,
        group.quantity.negated(),
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

  /** Émet stock:updated + stock:lowAlert/notification — patron identique à SaleService. */
  private emitStockEvents(organizationId: string, warehouseId: string, stockUpdates: StockUpdate[]): void {
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
            this.logger.error('Erreur création notification stock.lowAlert (POS)', err);
          });
      }
    }
  }

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

  private async verifyWarehouseOwnership(
    tx: Prisma.TransactionClient | PrismaService,
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

  private async verifyDetailsOwnership(
    tx: Prisma.TransactionClient,
    details: PosLineDto[],
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
