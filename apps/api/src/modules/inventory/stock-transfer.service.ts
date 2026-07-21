import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentType, Prisma, TransferStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ProductWarehouseService, OptimisticLockException } from './product-warehouse.service';
import type { CreateStockTransferDto } from './dto/create-stock-transfer.dto';
import type { PaginatedResult } from '../../common/types';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface TransferDetailResponse {
  id: string;
  productId: string;
  productVariantId: string | null;
  quantity: Decimal;
}

export interface TransferResponse {
  id: string;
  organizationId: string;
  reference: string;
  date: Date;
  fromWarehouseId: string;
  toWarehouseId: string;
  userId: string;
  note: string | null;
  status: TransferStatus;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  details?: TransferDetailResponse[];
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const TRANSFER_SELECT = {
  id: true,
  organizationId: true,
  reference: true,
  date: true,
  fromWarehouseId: true,
  toWarehouseId: true,
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
  quantity: true,
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des transferts de stock entre entrepôts (S17 — Bloc D).
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - fromWarehouseId ≠ toWarehouseId — BadRequestException sinon.
 *  - fromWarehouseId, toWarehouseId et chaque productId vérifient l'ownership avant tout accès.
 *  - Le stock n'est mouvementé qu'à la validation (status DRAFT → VALIDATED), jamais à la création.
 *  - Atomicité stricte : source ET destination dans la même transaction Serializable.
 *  - adjustStock est appelé dans la transaction Prisma (verrouillage optimiste §17 point B).
 *  - Référence générée via DocumentCounterService.nextReference dans la transaction (§17 point X).
 *  - quantity est Decimal — jamais Float (§17 point A).
 *  - Un transfert VALIDATED est immuable : ni modification, ni suppression physique.
 */
@Injectable()
export class StockTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly productWarehouseService: ProductWarehouseService,
  ) {}

  /**
   * Crée un transfert en statut DRAFT avec ses lignes dans une transaction.
   * Référence générée via DocumentCounterService.nextReference.
   * Vérifie l'ownership des deux entrepôts et de chaque productId (anti-IDOR).
   *
   * @throws BadRequestException si fromWarehouseId === toWarehouseId.
   * @throws NotFoundException si un entrepôt ou produit est introuvable.
   * @throws ForbiddenException si un entrepôt ou produit n'appartient pas à l'organisation.
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateStockTransferDto,
  ): Promise<TransferResponse> {
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException(
        "L'entrepôt source et l'entrepôt destination doivent être différents.",
      );
    }

    await Promise.all([
      this.verifyWarehouseOwnership(dto.fromWarehouseId, organizationId),
      this.verifyWarehouseOwnership(dto.toWarehouseId, organizationId),
    ]);
    await this.verifyProductsOwnership(
      dto.details.map((d) => d.productId),
      organizationId,
    );
    await this.verifyProductVariantsOwnership(dto.details, organizationId);

    const transfer = await this.prisma.$transaction(async (tx) => {
      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.TRANSFER,
      );

      return tx.stockTransfer.create({
        data: {
          organizationId,
          reference,
          date: new Date(dto.date),
          fromWarehouseId: dto.fromWarehouseId,
          toWarehouseId: dto.toWarehouseId,
          userId,
          note: dto.note,
          status: 'DRAFT',
          details: {
            create: dto.details.map((d) => ({
              productId: d.productId,
              productVariantId: d.productVariantId ?? null,
              quantity: new Decimal(d.quantity),
            })),
          },
        },
        select: {
          ...TRANSFER_SELECT,
          details: { select: DETAIL_SELECT },
        },
      });
    });

    return transfer;
  }

  /**
   * Valide un transfert DRAFT : décrémente l'entrepôt source et incrémente l'entrepôt
   * destination pour chaque ligne, dans une seule transaction Serializable.
   *
   * Le findUnique + contrôle de statut sont effectués DANS la transaction Serializable
   * pour éliminer le TOCTOU : deux requêtes concurrentes ne peuvent pas toutes deux
   * passer le check DRAFT et double-appliquer le mouvement de stock.
   *
   * @throws BadRequestException si le transfert n'est pas en statut DRAFT.
   * @throws ConflictException si un conflit de version optimiste ou de sérialisation (P2034).
   * @throws NotFoundException si le transfert ou un ProductWarehouse est introuvable.
   * @throws ForbiddenException si le transfert n'appartient pas à l'organisation.
   */
  async validate(id: string, organizationId: string): Promise<TransferResponse> {
    type StockUpdate = {
      productId: string;
      newQuantityFrom: Decimal;
      productName: string;
      stockAlert: number;
    };

    const stockUpdates: StockUpdate[] = [];
    let capturedFromWarehouseId!: string;
    let capturedToWarehouseId!: string;

    await this.prisma.$transaction(
      async (tx) => {
        // Lire le statut DANS la transaction Serializable — élimine le TOCTOU entre
        // deux requêtes concurrentes de validation sur le même transfert.
        const existing = await tx.stockTransfer.findUnique({
          where: { id },
          select: {
            ...TRANSFER_SELECT,
            details: { select: DETAIL_SELECT },
          },
        });

        if (!existing || existing.deletedAt !== null) {
          throw new NotFoundException('Transfert introuvable.');
        }
        if (existing.organizationId !== organizationId) {
          throw new ForbiddenException('Accès refusé.');
        }
        if (existing.status !== 'DRAFT') {
          throw new BadRequestException(
            'Ce transfert est déjà validé et ne peut pas être revalidé.',
          );
        }

        capturedFromWarehouseId = existing.fromWarehouseId;
        capturedToWarehouseId = existing.toWarehouseId;

        for (const detail of existing.details) {
          // Filtre product: { organizationId } : protège contre l'IDOR sur productVariantId
          const pwFrom = await tx.productWarehouse.findFirst({
            where: {
              productId: detail.productId,
              warehouseId: existing.fromWarehouseId,
              productVariantId: detail.productVariantId ?? null,
              product: { organizationId },
            },
            select: {
              id: true,
              version: true,
              product: { select: { stockAlert: true, name: true } },
            },
          });

          if (!pwFrom) {
            throw new NotFoundException(
              `Stock introuvable pour le produit ${detail.productId} dans l'entrepôt source. ` +
                'Initialisez le stock avant de créer un transfert.',
            );
          }

          const pwTo = await tx.productWarehouse.findFirst({
            where: {
              productId: detail.productId,
              warehouseId: existing.toWarehouseId,
              productVariantId: detail.productVariantId ?? null,
              product: { organizationId },
            },
            select: { id: true, version: true },
          });

          if (!pwTo) {
            throw new NotFoundException(
              `Stock introuvable pour le produit ${detail.productId} dans l'entrepôt destination. ` +
                'Initialisez le stock avant de créer un transfert.',
            );
          }

          const delta = new Decimal(detail.quantity);

          // Décrémente la source
          const updatedFrom = await this.productWarehouseService.adjustStock(
            tx,
            pwFrom.id,
            organizationId,
            delta.negated(),
            pwFrom.version,
          );

          // Incrémente la destination
          await this.productWarehouseService.adjustStock(
            tx,
            pwTo.id,
            organizationId,
            delta,
            pwTo.version,
          );

          stockUpdates.push({
            productId: detail.productId,
            newQuantityFrom: updatedFrom.quantity,
            productName: pwFrom.product.name,
            stockAlert: pwFrom.product.stockAlert,
          });
        }

        await tx.stockTransfer.update({
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

    // Émettre stock:updated après la transaction réussie — un événement par entrepôt
    const updatedProducts = stockUpdates.map((u) => ({
      productId: u.productId,
      newQuantity: u.newQuantityFrom,
    }));

    this.realtimeGateway.server
      .to(`org:${organizationId}`)
      .emit('stock:updated', {
        warehouseId: capturedFromWarehouseId,
        products: updatedProducts,
      });

    this.realtimeGateway.server
      .to(`org:${organizationId}`)
      .emit('stock:updated', {
        warehouseId: capturedToWarehouseId,
        products: stockUpdates.map((u) => ({ productId: u.productId })),
      });

    // stock:lowAlert si la quantité source après décrémentation atteint le seuil
    for (const update of stockUpdates) {
      if (
        update.stockAlert > 0 &&
        update.newQuantityFrom.lessThanOrEqualTo(new Decimal(update.stockAlert))
      ) {
        this.realtimeGateway.server
          .to(`org:${organizationId}`)
          .emit('stock:lowAlert', {
            productId: update.productId,
            productName: update.productName,
            currentQuantity: update.newQuantityFrom,
            threshold: update.stockAlert,
          });
        // TODO S18: persister dans Notification
      }
    }

    const validated = await this.prisma.stockTransfer.findUniqueOrThrow({
      where: { id },
      select: {
        ...TRANSFER_SELECT,
        details: { select: DETAIL_SELECT },
      },
    });

    return validated;
  }

  /**
   * Retourne la liste paginée des transferts de l'organisation.
   * Filtrables par fromWarehouseId, toWarehouseId et status.
   */
  async findAll(
    organizationId: string,
    page: number,
    limit: number,
    fromWarehouseId?: string,
    toWarehouseId?: string,
    status?: TransferStatus,
  ): Promise<PaginatedResult<TransferResponse>> {
    if (fromWarehouseId) {
      await this.verifyWarehouseOwnership(fromWarehouseId, organizationId);
    }
    if (toWarehouseId) {
      await this.verifyWarehouseOwnership(toWarehouseId, organizationId);
    }

    const where: Prisma.StockTransferWhereInput = {
      organizationId,
      deletedAt: null,
      ...(fromWarehouseId ? { fromWarehouseId } : {}),
      ...(toWarehouseId ? { toWarehouseId } : {}),
      ...(status ? { status } : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockTransfer.findMany({
        where,
        select: TRANSFER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  /**
   * Retourne un transfert par ID avec ses lignes.
   * Vérifie l'ownership (anti-IDOR).
   */
  async findOne(id: string, organizationId: string): Promise<TransferResponse> {
    const transfer = await this.prisma.stockTransfer.findUnique({
      where: { id },
      select: {
        ...TRANSFER_SELECT,
        details: { select: DETAIL_SELECT },
      },
    });

    if (!transfer || transfer.deletedAt !== null) {
      throw new NotFoundException('Transfert introuvable.');
    }
    if (transfer.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return transfer;
  }

  /**
   * Soft-delete d'un transfert — uniquement si statut DRAFT.
   * Un transfert VALIDATED ne peut jamais être supprimé (§17 point 7).
   */
  async remove(id: string, organizationId: string): Promise<void> {
    const transfer = await this.prisma.stockTransfer.findUnique({
      where: { id },
      select: { organizationId: true, status: true, deletedAt: true },
    });

    if (!transfer || transfer.deletedAt !== null) {
      throw new NotFoundException('Transfert introuvable.');
    }
    if (transfer.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (transfer.status === 'VALIDATED') {
      throw new BadRequestException(
        'Un transfert validé ne peut pas être supprimé.',
      );
    }

    await this.prisma.stockTransfer.update({
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
