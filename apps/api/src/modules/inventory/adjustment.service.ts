import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { AdjustmentStatus, DocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ProductWarehouseService, OptimisticLockException } from './product-warehouse.service';
import type { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import type { PaginatedResult } from '../../common/types';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface AdjustmentDetailResponse {
  id: string;
  productId: string;
  productVariantId: string | null;
  type: string;
  quantity: Decimal;
  unitCost: Decimal;
}

export interface AdjustmentResponse {
  id: string;
  organizationId: string;
  reference: string;
  date: Date;
  warehouseId: string;
  userId: string;
  note: string | null;
  status: AdjustmentStatus;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  details?: AdjustmentDetailResponse[];
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const ADJUSTMENT_SELECT = {
  id: true,
  organizationId: true,
  reference: true,
  date: true,
  warehouseId: true,
  userId: true,
  note: true,
  status: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DETAIL_SELECT = {
  id: true,
  productId: true,
  productVariantId: true,
  type: true,
  quantity: true,
  unitCost: true,
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des ajustements de stock (S16 — Bloc D).
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - warehouseId et chaque productId vérifient l'ownership de l'org avant tout accès.
 *  - Le stock n'est mouvementé qu'à la validation (status DRAFT → VALIDATED), jamais à la création.
 *  - adjustStock est appelé dans la transaction Prisma (verrouillage optimiste §17 point B).
 *  - Référence générée via DocumentCounterService.nextReference dans la transaction (§17 point X).
 *  - quantity et unitCost sont Decimal — jamais Float (§17 point A).
 *  - Un ajustement VALIDATED est immuable : ni modification, ni suppression physique.
 */
@Injectable()
export class AdjustmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly productWarehouseService: ProductWarehouseService,
  ) {}

  /**
   * Crée un ajustement en statut DRAFT avec ses lignes dans une transaction.
   * Référence générée via DocumentCounterService.nextReference.
   * Vérifie l'ownership du warehouseId et de chaque productId (anti-IDOR).
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateAdjustmentDto,
  ): Promise<AdjustmentResponse> {
    await this.verifyWarehouseOwnership(dto.warehouseId, organizationId);
    await this.verifyProductsOwnership(
      dto.details.map((d) => d.productId),
      organizationId,
    );
    await this.verifyProductVariantsOwnership(dto.details, organizationId);

    const adjustment = await this.prisma.$transaction(async (tx) => {
      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.ADJUSTMENT,
      );

      return tx.adjustment.create({
        data: {
          organizationId,
          reference,
          date: new Date(dto.date),
          warehouseId: dto.warehouseId,
          userId,
          note: dto.note,
          status: 'DRAFT',
          details: {
            create: dto.details.map((d) => ({
              productId: d.productId,
              productVariantId: d.productVariantId ?? null,
              type: d.type,
              quantity: new Decimal(d.quantity),
              unitCost: d.unitCost !== undefined ? new Decimal(d.unitCost) : new Decimal(0),
            })),
          },
        },
        select: {
          ...ADJUSTMENT_SELECT,
          details: { select: DETAIL_SELECT },
        },
      });
    });

    return adjustment;
  }

  /**
   * Valide un ajustement DRAFT : mouvemente le stock de chaque ligne via adjustStock
   * dans une transaction Serializable, puis passe status = VALIDATED.
   * Émet stock:updated et stock:lowAlert (si seuil atteint) après la transaction.
   *
   * Le findUnique + contrôle de statut sont effectués DANS la transaction Serializable
   * pour éliminer le TOCTOU : deux requêtes concurrentes ne peuvent pas toutes deux
   * passer le check DRAFT et double-appliquer le mouvement de stock.
   *
   * @throws BadRequestException si l'ajustement n'est pas en statut DRAFT.
   * @throws ConflictException si un conflit de version optimiste ou de sérialisation est détecté (409).
   * @throws NotFoundException si l'ajustement ou un ProductWarehouse est introuvable.
   */
  async validate(id: string, organizationId: string): Promise<AdjustmentResponse> {
    const stockUpdates: Array<{
      productId: string;
      newQuantity: Decimal;
      productName: string;
      stockAlert: number;
      isSoustraction: boolean;
    }> = [];

    // warehouseId capturé depuis la transaction pour les émissions WebSocket post-transaction
    let capturedWarehouseId!: string;

    await this.prisma.$transaction(
      async (tx) => {
        // Lire le statut DANS la transaction Serializable — élimine le TOCTOU entre
        // deux requêtes concurrentes de validation sur le même ajustement.
        const existing = await tx.adjustment.findUnique({
          where: { id },
          select: {
            ...ADJUSTMENT_SELECT,
            details: { select: DETAIL_SELECT },
          },
        });

        if (!existing || existing.deletedAt !== null) {
          throw new NotFoundException('Ajustement introuvable.');
        }
        if (existing.organizationId !== organizationId) {
          throw new ForbiddenException('Accès refusé.');
        }
        if (existing.status !== 'DRAFT') {
          throw new BadRequestException(
            "Cet ajustement est déjà validé et ne peut pas être revalidé.",
          );
        }

        capturedWarehouseId = existing.warehouseId;

        for (const detail of existing.details) {
          // Filtre product: { organizationId } : protège contre l'IDOR sur productVariantId
          // (un attaquant ne peut pas pointer vers un ProductWarehouse d'une autre org)
          const pw = await tx.productWarehouse.findFirst({
            where: {
              productId: detail.productId,
              warehouseId: existing.warehouseId,
              productVariantId: detail.productVariantId ?? null,
              product: { organizationId },
            },
            select: { id: true, version: true, product: { select: { stockAlert: true, name: true } } },
          });

          if (!pw) {
            throw new NotFoundException(
              `Stock introuvable pour le produit ${detail.productId} dans cet entrepôt. ` +
                'Initialisez le stock avant de créer un ajustement.',
            );
          }

          const delta =
            detail.type === 'ADDITION'
              ? new Decimal(detail.quantity)
              : new Decimal(detail.quantity).negated();

          const updated = await this.productWarehouseService.adjustStock(
            tx,
            pw.id,
            organizationId,
            delta,
            pw.version,
          );

          stockUpdates.push({
            productId: detail.productId,
            newQuantity: updated.quantity,
            productName: pw.product.name,
            stockAlert: pw.product.stockAlert,
            isSoustraction: detail.type === 'SOUSTRACTION',
          });
        }

        await tx.adjustment.update({
          where: { id },
          data: { status: 'VALIDATED' },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ).catch((err: unknown) => {
      if (err instanceof OptimisticLockException) {
        throw new ConflictException(
          'Conflit de version sur le stock : un autre utilisateur a modifié le stock simultanément. Veuillez réessayer.',
        );
      }
      // P2034 : échec de sérialisation PostgreSQL (SSI) — se produit si la transaction
      // Serializable détecte un conflit que l'optimistic lock n'a pas attrapé en premier.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2034'
      ) {
        throw new ConflictException(
          'Conflit de concurrence détecté. Veuillez réessayer.',
        );
      }
      throw err;
    });

    // Émettre stock:updated après la transaction réussie (jamais avant)
    const updatedProducts = stockUpdates.map((u) => ({
      productId: u.productId,
      newQuantity: u.newQuantity,
    }));

    this.realtimeGateway.server
      .to(`org:${organizationId}`)
      .emit('stock:updated', {
        warehouseId: capturedWarehouseId,
        products: updatedProducts,
      });

    // Émettre stock:lowAlert pour chaque soustraction ayant atteint le seuil
    for (const update of stockUpdates) {
      if (
        update.isSoustraction &&
        update.stockAlert > 0 &&
        update.newQuantity.lessThanOrEqualTo(new Decimal(update.stockAlert))
      ) {
        this.realtimeGateway.server
          .to(`org:${organizationId}`)
          .emit('stock:lowAlert', {
            productId: update.productId,
            productName: update.productName,
            currentQuantity: update.newQuantity,
            threshold: update.stockAlert,
          });
        // TODO S18: persister dans Notification
      }
    }

    const validated = await this.prisma.adjustment.findUniqueOrThrow({
      where: { id },
      select: {
        ...ADJUSTMENT_SELECT,
        details: { select: DETAIL_SELECT },
      },
    });

    return validated;
  }

  /**
   * Retourne la liste paginée des ajustements de l'organisation.
   * Filtrables par warehouseId et status.
   */
  async findAll(
    organizationId: string,
    page: number,
    limit: number,
    warehouseId?: string,
    status?: AdjustmentStatus,
  ): Promise<PaginatedResult<AdjustmentResponse>> {
    // Vérifier l'ownership du warehouseId fourni en filtre (anti-oracle d'énumération)
    if (warehouseId) {
      await this.verifyWarehouseOwnership(warehouseId, organizationId);
    }

    const where: Prisma.AdjustmentWhereInput = {
      organizationId,
      deletedAt: null,
      ...(warehouseId ? { warehouseId } : {}),
      ...(status ? { status } : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.adjustment.findMany({
        where,
        select: ADJUSTMENT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.adjustment.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  /**
   * Retourne un ajustement par ID avec ses lignes.
   * Vérifie l'ownership (anti-IDOR).
   */
  async findOne(id: string, organizationId: string): Promise<AdjustmentResponse> {
    const adjustment = await this.prisma.adjustment.findUnique({
      where: { id },
      select: {
        ...ADJUSTMENT_SELECT,
        details: { select: DETAIL_SELECT },
      },
    });

    if (!adjustment || adjustment.deletedAt !== null) {
      throw new NotFoundException('Ajustement introuvable.');
    }
    if (adjustment.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return adjustment;
  }

  /**
   * Soft-delete d'un ajustement — uniquement si statut DRAFT.
   * Un ajustement VALIDATED ne peut jamais être supprimé (§17 point 7).
   */
  async remove(id: string, organizationId: string): Promise<void> {
    const adjustment = await this.prisma.adjustment.findUnique({
      where: { id },
      select: { organizationId: true, status: true, deletedAt: true },
    });

    if (!adjustment || adjustment.deletedAt !== null) {
      throw new NotFoundException('Ajustement introuvable.');
    }
    if (adjustment.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (adjustment.status === 'VALIDATED') {
      throw new BadRequestException(
        'Un ajustement validé ne peut pas être supprimé. Créez un ajustement correctif.',
      );
    }

    await this.prisma.adjustment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
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

  /**
   * Vérifie que tous les produits appartiennent à l'organisation (anti-IDOR).
   */
  private async verifyProductsOwnership(
    productIds: string[],
    organizationId: string,
  ): Promise<void> {
    const uniqueIds = [...new Set(productIds)];

    const products = await this.prisma.product.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, organizationId: true, deletedAt: true },
    });

    for (const pid of uniqueIds) {
      const product = products.find((p) => p.id === pid);
      if (!product || product.deletedAt !== null) {
        throw new NotFoundException(`Produit ${pid} introuvable.`);
      }
      if (product.organizationId !== organizationId) {
        throw new ForbiddenException(`Accès refusé au produit ${pid}.`);
      }
    }
  }

  /**
   * Vérifie que chaque productVariantId appartient au productId déclaré dans la même ligne
   * et à l'organisation courante (anti-IDOR).
   * Les lignes sans variante sont ignorées.
   */
  private async verifyProductVariantsOwnership(
    details: Array<{ productId: string; productVariantId?: string }>,
    organizationId: string,
  ): Promise<void> {
    const variantDetails = details.filter((d) => d.productVariantId);
    if (variantDetails.length === 0) return;

    const uniqueVariantIds = [...new Set(variantDetails.map((d) => d.productVariantId!))];

    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: uniqueVariantIds }, deletedAt: null },
      select: {
        id: true,
        productId: true,
        product: { select: { organizationId: true } },
      },
    });

    for (const detail of variantDetails) {
      const variant = variants.find((v) => v.id === detail.productVariantId);
      if (!variant) {
        throw new NotFoundException(`Variante ${detail.productVariantId!} introuvable.`);
      }
      if (variant.productId !== detail.productId) {
        throw new ForbiddenException(
          `La variante ${detail.productVariantId!} n'appartient pas au produit ${detail.productId}.`,
        );
      }
      if (variant.product.organizationId !== organizationId) {
        throw new ForbiddenException(`Accès refusé à la variante ${detail.productVariantId!}.`);
      }
    }
  }
}
