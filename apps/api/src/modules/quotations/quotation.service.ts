import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { CreateQuotationDto, QuotationDetailDto } from './dto/create-quotation.dto';
import type { UpdateQuotationDto } from './dto/update-quotation.dto';
import type { PaginatedResult } from '../../common/types';
import type { SaleResponse } from '../sales/sale.service';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface QuotationDetailResponse {
  id: string;
  productId: string;
  productVariantId: string | null;
  quoteUnitId: string | null;
  price: Decimal;
  taxAmount: Decimal | null;
  taxMethod: string | null;
  discount: Decimal | null;
  discountMethod: string | null;
  quantity: Decimal;
  total: Decimal;
}

export interface QuotationResponse {
  id: string;
  organizationId: string;
  reference: string;
  date: Date;
  userId: string;
  clientId: string;
  warehouseId: string;
  taxRate: Decimal | null;
  taxAmount: Decimal | null;
  discount: Decimal | null;
  shipping: Decimal | null;
  grandTotal: Decimal;
  status: DocumentStatus;
  notes: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  client?: { id: string; name: string };
  warehouse?: { id: string; name: string };
  details?: QuotationDetailResponse[];
}

/** Ligne de devis après calcul serveur — jamais confiance dans un total client (§17 point A). */
interface ComputedLine {
  productId: string;
  productVariantId: string | null;
  quoteUnitId: string | null;
  price: Decimal;
  taxAmount: Decimal;
  taxMethod: string;
  discount: Decimal;
  discountMethod: string;
  quantity: Decimal;
  total: Decimal;
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const QUOTATION_SELECT = {
  id: true,
  organizationId: true,
  reference: true,
  date: true,
  userId: true,
  clientId: true,
  warehouseId: true,
  taxRate: true,
  taxAmount: true,
  discount: true,
  shipping: true,
  grandTotal: true,
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
  quoteUnitId: true,
  price: true,
  taxAmount: true,
  taxMethod: true,
  discount: true,
  discountMethod: true,
  quantity: true,
  total: true,
} as const;

const CLIENT_WAREHOUSE_INCLUDE = {
  // email/phone nécessaires pour send() (mirror SaleService — S24) — ajout additif,
  // ne casse aucun usage existant (create/findOne ignorent simplement ces deux champs).
  client: { select: { id: true, name: true, email: true, phone: true } },
  warehouse: { select: { id: true, name: true } },
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des devis (S28, §18.4) — mirror de SaleService (S19) avec des invariants
 * propres au devis :
 *
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - clientId, warehouseId et chaque productId/productVariantId/quoteUnitId vérifient
 *    l'ownership DANS la transaction avant tout accès — élimine le TOCTOU.
 *  - Tous les totaux (ligne et en-tête) sont calculés côté serveur — jamais depuis le
 *    body client (§17 point A). price/quantity/taxAmount/discount en Decimal.
 *  - Référence générée via DocumentCounterService.nextReference dans la transaction
 *    (§17 point X), séquence DocumentType.QUOTATION (préfixe "DEV") pour create()/update().
 *  - AUCUN mouvement de stock, jamais : ni à la création, ni à update()/remove(), ni à
 *    convert() — un devis ne réserve ni ne décrémente le stock ; seule la vente issue de
 *    la conversion (SaleService.validate(), hors périmètre de cette session) mouvemente
 *    le stock.
 *  - AUCUN paymentStatus/paidAmount — un devis n'est jamais payé (contrairement à Sale).
 *  - Seul un devis PENDING peut être modifié, supprimé ou converti ; un devis COMPLETED
 *    (déjà converti) ou CANCELLED est immuable (§17 point 7).
 *  - convert() est l'action spécifique à Quotation, sans équivalent dans SaleService :
 *    elle crée une Sale (statut PENDING, paymentStatus UNPAID) directement via
 *    tx.sale.create — SalesModule n'est pas importé ici (frontière de module claire,
 *    même principe que PosService qui duplique groupDetailsByProduct plutôt que de
 *    dépendre de SalesModule) — copie les lignes 1:1 (quoteUnitId → saleUnitId, aucun
 *    recalcul, les totaux ont déjà été calculés côté serveur à la création du devis),
 *    puis fait passer le devis à COMPLETED. La référence de la vente créée réutilise la
 *    séquence DocumentType.SALE (mêmes préfixe/compteur que les ventes classiques),
 *    PAS une séquence DEV dédiée.
 */
@Injectable()
export class QuotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
    // Files BullMQ d'envoi de récapitulatif de devis (S28, mirror S24) — le worker
    // recharge lui-même le devis à partir de quotationId, aucun autre payload que
    // l'organisationId/quotationId/to n'est transporté (§17 point 12).
    @InjectQueue('email')
    private readonly emailQueue: Queue<{ organizationId: string; quotationId: string; to: string }>,
    @InjectQueue('sms')
    private readonly smsQueue: Queue<{ organizationId: string; quotationId: string; to: string }>,
  ) {}

  /**
   * Crée un devis en statut PENDING avec ses lignes dans une transaction.
   * Référence générée via DocumentCounterService.nextReference (DocumentType.QUOTATION).
   * Émet quotation:created vers org:{organizationId} (S30 — notification temps réel,
   * même si aucune UI ne l'écoute encore).
   *
   * @throws NotFoundException si le client, l'entrepôt, un produit, une variante ou
   *         une unité de devis est introuvable.
   * @throws ForbiddenException si l'une de ces ressources n'appartient pas à l'organisation.
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateQuotationDto,
  ): Promise<QuotationResponse> {
    const quotation = await this.prisma.$transaction(async (tx) => {
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
        DocumentType.QUOTATION,
      );

      return tx.quotation.create({
        data: {
          organizationId,
          reference,
          date: new Date(dto.date),
          userId,
          clientId: dto.clientId,
          warehouseId: dto.warehouseId,
          taxRate,
          taxAmount: taxGlobal,
          discount,
          shipping,
          grandTotal,
          status: 'PENDING',
          notes: dto.notes,
          details: { create: computed.map((d) => this.toDetailCreateInput(d)) },
        },
        select: { ...QUOTATION_SELECT, ...CLIENT_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
      });
    });

    this.realtimeGateway.server.to(`org:${organizationId}`).emit('quotation:created', {
      organizationId,
      quotationId: quotation.id,
      warehouseId: quotation.warehouseId,
      grandTotal: quotation.grandTotal,
    });

    return quotation;
  }

  /**
   * Convertit un devis PENDING en vente (S28, §18.4) : crée une Sale PENDING avec les
   * mêmes lignes (quoteUnitId → saleUnitId, aucun recalcul), fait passer le devis à
   * COMPLETED — le tout dans une seule transaction Prisma standard (pas de stock en jeu,
   * pas besoin d'isolationLevel Serializable ni de verrouillage optimiste).
   *
   * Le devis et ses lignes sont relus DANS la transaction pour éliminer le TOCTOU : deux
   * requêtes concurrentes de conversion sur le même devis ne peuvent pas toutes deux
   * passer le contrôle PENDING et créer deux ventes pour un même devis (Sale.quotationId
   * est de toute façon @unique en base, filet de sécurité supplémentaire).
   *
   * La vente créée a sa propre date (`new Date()`), pas la date du devis — une vente a
   * son propre cycle de vie, indépendant du devis d'origine.
   *
   * @param id - identifiant du devis à convertir.
   * @param organizationId - organisation de l'utilisateur authentifié (anti-IDOR).
   * @param userId - utilisateur à l'origine de la conversion (userId de la vente créée).
   * @returns La vente créée (mêmes champs qu'un SaleResponse classique avec details).
   * @throws NotFoundException si le devis est introuvable ou soft-supprimé.
   * @throws ForbiddenException si le devis n'appartient pas à l'organisation.
   * @throws BadRequestException si le devis n'est pas PENDING (déjà converti ou annulé).
   * @throws ConflictException si une conversion concurrente sur le même devis a déjà
   *         créé la vente entre la lecture et l'écriture (violation de la contrainte
   *         unique Sale.quotationId — cf. rethrowConversionConflict).
   */
  async convert(id: string, organizationId: string, userId: string): Promise<SaleResponse> {
    const sale = await this.prisma
      .$transaction(async (tx) => {
        const existing = await tx.quotation.findUnique({
          where: { id },
          select: { ...QUOTATION_SELECT, details: { select: DETAIL_SELECT } },
        });

        if (!existing || existing.deletedAt !== null) {
          throw new NotFoundException('Devis introuvable.');
        }
        if (existing.organizationId !== organizationId) {
          throw new ForbiddenException('Accès refusé.');
        }
        if (existing.status !== 'PENDING') {
          throw new BadRequestException('Ce devis est déjà converti ou annulé.');
        }

        const reference = await this.documentCounter.nextReference(
          tx,
          organizationId,
          DocumentType.SALE,
        );

        const createdSale = await tx.sale.create({
          data: {
            organizationId,
            reference,
            date: new Date(),
            isPos: false,
            userId,
            clientId: existing.clientId,
            warehouseId: existing.warehouseId,
            taxRate: existing.taxRate,
            taxAmount: existing.taxAmount,
            discount: existing.discount,
            shipping: existing.shipping,
            grandTotal: existing.grandTotal,
            paidAmount: new Decimal(0),
            paymentStatus: 'UNPAID',
            status: 'PENDING',
            notes: existing.notes,
            quotationId: existing.id,
            details: {
              create: existing.details.map((d) => ({
                productId: d.productId,
                productVariantId: d.productVariantId,
                saleUnitId: d.quoteUnitId,
                price: d.price,
                taxAmount: d.taxAmount,
                taxMethod: d.taxMethod,
                discount: d.discount,
                discountMethod: d.discountMethod,
                quantity: d.quantity,
                total: d.total,
              })),
            },
          },
          select: {
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
            client: { select: { id: true, name: true } },
            warehouse: { select: { id: true, name: true } },
            details: {
              select: {
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
              },
            },
          },
        });

        await tx.quotation.update({ where: { id }, data: { status: 'COMPLETED' } });

        return createdSale;
      })
      .catch((err: unknown) => this.rethrowConversionConflict(err));

    // Aucun mouvement de stock (donc aucun stock:updated) — seule sale:created est émis,
    // mirror du comportement de SaleService.create()/PurchaseService.create() pour toute
    // nouvelle vente/achat : la vente créée apparaît en temps réel dans la liste existante.
    this.realtimeGateway.server.to(`org:${organizationId}`).emit('sale:created', {
      organizationId,
      saleId: sale.id,
      warehouseId: sale.warehouseId,
      grandTotal: sale.grandTotal,
    });

    return sale;
  }

  /**
   * Retourne la liste paginée des devis de l'organisation.
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
  ): Promise<PaginatedResult<QuotationResponse>> {
    const where: Prisma.QuotationWhereInput = {
      organizationId,
      deletedAt: null,
      ...(viewAll ? {} : { userId }),
      ...(clientId ? { clientId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(status ? { status } : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.quotation.findMany({
        where,
        select: QUOTATION_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.quotation.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  /**
   * Retourne un devis par ID avec ses lignes, son client et son entrepôt.
   * Vérifie l'ownership (anti-IDOR).
   */
  async findOne(id: string, organizationId: string): Promise<QuotationResponse> {
    const quotation = await this.prisma.quotation.findUnique({
      where: { id },
      select: { ...QUOTATION_SELECT, ...CLIENT_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
    });

    if (!quotation || quotation.deletedAt !== null) {
      throw new NotFoundException('Devis introuvable.');
    }
    if (quotation.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return quotation;
  }

  /**
   * Envoie le récapitulatif d'un devis au client par email ou SMS (S28, mirror exact de
   * SaleService.send() — S24). Enfile un job BullMQ ('quotation.sendEmail' ou
   * 'quotation.sendSms', file 'email'/'sms') consommé par un worker dédié qui recharge
   * lui-même le devis et compose le message — cette méthode ne fait aucun appel réseau
   * synchrone (fire-and-forget) et retourne dès que le job est enfilé.
   *
   * Aucune restriction de statut : un devis PENDING, COMPLETED ou CANCELLED peut être
   * partagé (mirror du comportement de SaleService.send()).
   *
   * @param id - identifiant du devis à envoyer.
   * @param organizationId - organisation de l'utilisateur authentifié (anti-IDOR).
   * @param channel - canal d'envoi : 'email' (nécessite client.email) ou 'sms' (nécessite client.phone).
   * @returns `{ status: 'queued' }` dès que le job est enfilé (pas d'attente de l'envoi réel).
   * @throws NotFoundException si le devis est introuvable ou soft-supprimé.
   * @throws ForbiddenException si le devis n'appartient pas à l'organisation.
   * @throws BadRequestException si le client n'a pas de contact enregistré pour le canal demandé.
   */
  async send(
    id: string,
    organizationId: string,
    channel: 'email' | 'sms',
  ): Promise<{ status: 'queued' }> {
    const quotation = await this.prisma.quotation.findUnique({
      where: { id },
      select: { ...QUOTATION_SELECT, ...CLIENT_WAREHOUSE_INCLUDE },
    });

    if (!quotation || quotation.deletedAt !== null) {
      throw new NotFoundException('Devis introuvable.');
    }
    if (quotation.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    if (channel === 'email') {
      const to = quotation.client.email;
      if (!to) {
        throw new BadRequestException("Ce client n'a pas d'adresse email enregistrée.");
      }
      await this.emailQueue.add('quotation.sendEmail', { organizationId, quotationId: id, to });
      return { status: 'queued' };
    }

    const to = quotation.client.phone;
    if (!to) {
      throw new BadRequestException("Ce client n'a pas de numéro de téléphone enregistré.");
    }
    await this.smsQueue.add('quotation.sendSms', { organizationId, quotationId: id, to });
    return { status: 'queued' };
  }

  /**
   * Met à jour un devis PENDING : ownership re-vérifiée si clientId/warehouseId change,
   * lignes intégralement remplacées si `details` est fourni (deleteMany + createMany dans
   * la transaction), totaux recalculés côté serveur dans tous les cas.
   *
   * @throws BadRequestException si le devis n'est pas PENDING.
   * @throws NotFoundException / ForbiddenException — cf. create().
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdateQuotationDto,
  ): Promise<QuotationResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.quotation.findUnique({
        where: { id },
        select: { ...QUOTATION_SELECT, details: { select: DETAIL_SELECT } },
      });

      if (!existing || existing.deletedAt !== null) {
        throw new NotFoundException('Devis introuvable.');
      }
      if (existing.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }
      if (existing.status !== 'PENDING') {
        throw new BadRequestException('Seul un devis en attente (PENDING) peut être modifié.');
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

        await tx.quotationDetail.deleteMany({ where: { quotationId: id } });
        await tx.quotationDetail.createMany({
          data: computed.map((d) => ({ quotationId: id, ...this.toDetailCreateInput(d) })),
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

      return tx.quotation.update({
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
        select: { ...QUOTATION_SELECT, ...CLIENT_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
      });
    });
  }

  /**
   * Soft-delete d'un devis — uniquement si statut PENDING.
   * Un devis COMPLETED (déjà converti) ou CANCELLED ne peut jamais être supprimé
   * (§17 point 7).
   */
  async remove(id: string, organizationId: string): Promise<void> {
    const quotation = await this.prisma.quotation.findUnique({
      where: { id },
      select: { organizationId: true, status: true, deletedAt: true },
    });

    if (!quotation || quotation.deletedAt !== null) {
      throw new NotFoundException('Devis introuvable.');
    }
    if (quotation.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (quotation.status !== 'PENDING') {
      throw new BadRequestException('Seul un devis en attente (PENDING) peut être supprimé.');
    }

    await this.prisma.quotation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Traduit une violation de la contrainte unique `Sale.quotationId` (P2002) — deux
   * conversions concurrentes sur le même devis PENDING : le SELECT initial de convert()
   * n'est pas verrouillé (transaction non-Serializable, aucun stock en jeu), donc deux
   * requêtes peuvent toutes deux lire le statut PENDING avant que l'une ne commite ; la
   * contrainte unique en base est le filet de sécurité qui empêche la double conversion,
   * mais sans cette traduction l'erreur Prisma brute remonterait en 500 générique au lieu
   * d'un message actionnable — patron identique à SaleService.rethrowStockConflict.
   */
  private rethrowConversionConflict(err: unknown): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictException(
        'Ce devis vient d\'être converti par une autre action. Rechargez la page.',
      );
    }
    throw err;
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
  private computeLineTotal(d: QuotationDetailDto): ComputedLine {
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
      quoteUnitId: d.quoteUnitId ?? null,
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
      quoteUnitId: d.quoteUnitId,
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
   * Vérifie l'ownership de chaque produit, variante et unité référencés par les
   * lignes — DANS la transaction (anti-IDOR + anti-TOCTOU).
   */
  private async verifyDetailsOwnership(
    tx: Prisma.TransactionClient,
    details: QuotationDetailDto[],
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

    const unitDetails = details.filter((d) => d.quoteUnitId);
    if (unitDetails.length > 0) {
      const unitIds = [...new Set(unitDetails.map((d) => d.quoteUnitId!))];
      const units = await tx.unit.findMany({
        where: { id: { in: unitIds }, deletedAt: null },
        select: { id: true, organizationId: true },
      });
      for (const detail of unitDetails) {
        const unit = units.find((u) => u.id === detail.quoteUnitId);
        if (!unit) {
          throw new NotFoundException('Unité de devis introuvable.');
        }
        if (unit.organizationId !== organizationId) {
          throw new ForbiddenException('Accès refusé.');
        }
      }
    }
  }
}
