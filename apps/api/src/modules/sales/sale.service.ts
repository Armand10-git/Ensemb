import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentStatus, DocumentType, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
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
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  client?: { id: string; name: string };
  warehouse?: { id: string; name: string };
  details?: SaleDetailResponse[];
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
  client: { select: { id: true, name: true } },
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
 */
@Injectable()
export class SaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
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
