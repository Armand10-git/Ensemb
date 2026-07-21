import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { PaginatedResult } from '../../common/types';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface StockEntry {
  id: string;
  productId: string;
  productVariantId: string | null;
  warehouseId: string;
  warehouseName: string;
  quantity: Decimal;
  version: number;
}

export interface StockSummary {
  productId: string;
  totalQuantity: Decimal;
  byWarehouse: StockEntry[];
}

// ─── Exception verrouillage optimiste ───────────────────────────────────────

/** Levée quand la version en base diffère de expectedVersion (conflit concurrent). */
export class OptimisticLockException extends Error {
  constructor(productWarehouseId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Conflit de version sur ProductWarehouse ${productWarehouseId} : ` +
        `attendu ${expectedVersion}, lu ${actualVersion}.`,
    );
    this.name = 'OptimisticLockException';
  }
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const STOCK_SELECT = {
  id: true,
  productId: true,
  productVariantId: true,
  warehouseId: true,
  warehouse: { select: { name: true } },
  quantity: true,
  version: true,
} as const;

function toStockEntry(row: {
  id: string;
  productId: string;
  productVariantId: string | null;
  warehouseId: string;
  warehouse: { name: string };
  quantity: Decimal;
  version: number;
}): StockEntry {
  return {
    id: row.id,
    productId: row.productId,
    productVariantId: row.productVariantId,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse.name,
    quantity: row.quantity,
    version: row.version,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion du stock par entrepôt (S15 — Bloc D).
 *
 * Invariants :
 *  - organizationId est toujours extrait de req.user (anti-IDOR).
 *  - L'ownership du produit est vérifié avant tout accès au stock (product.organizationId === org).
 *  - adjustStock n'est pas exposé via HTTP — réservé aux transactions POS/ajustement (S21).
 *  - quantity est Decimal (§17 point A), version est Int (§17 point B).
 */
@Injectable()
export class ProductWarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne tous les enregistrements de stock d'un produit (tous entrepôts de l'org).
   * Vérifie que le produit appartient à l'organisation (anti-IDOR).
   */
  async findByProduct(
    productId: string,
    organizationId: string,
  ): Promise<StockEntry[]> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { organizationId: true, deletedAt: true },
    });

    if (!product || product.deletedAt !== null) {
      throw new NotFoundException('Produit introuvable.');
    }
    if (product.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const rows = await this.prisma.productWarehouse.findMany({
      where: { productId },
      select: STOCK_SELECT,
      orderBy: { warehouseId: 'asc' },
    });

    return rows.map(toStockEntry);
  }

  /**
   * Retourne le stock paginé d'un entrepôt (scopé organisation via la relation warehouse).
   */
  async findByWarehouse(
    warehouseId: string,
    organizationId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<StockEntry>> {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { organizationId: true, deletedAt: true },
    });

    if (!warehouse || warehouse.deletedAt !== null) {
      throw new NotFoundException('Entrepôt introuvable.');
    }
    if (warehouse.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.productWarehouse.findMany({
        where: { warehouseId },
        select: STOCK_SELECT,
        orderBy: { productId: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.productWarehouse.count({ where: { warehouseId } }),
    ]);

    return { data: rows.map(toStockEntry), total, page, limit };
  }

  /**
   * Initialise le stock d'un (produit, entrepôt) à zéro si absent (idempotent via upsert).
   * Vérifie l'ownership du produit et de l'entrepôt.
   */
  async initStock(
    productId: string,
    warehouseId: string,
    organizationId: string,
    quantity?: Decimal,
  ): Promise<StockEntry> {
    const [product, warehouse] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id: productId },
        select: { organizationId: true, deletedAt: true },
      }),
      this.prisma.warehouse.findUnique({
        where: { id: warehouseId },
        select: { organizationId: true, deletedAt: true },
      }),
    ]);

    if (!product || product.deletedAt !== null) {
      throw new NotFoundException('Produit introuvable.');
    }
    if (product.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (!warehouse || warehouse.deletedAt !== null) {
      throw new NotFoundException('Entrepôt introuvable.');
    }
    if (warehouse.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    // Upsert sans variante (productVariantId IS NULL) — index partiel SQL garantit l'unicité.
    // On ne peut pas utiliser un connectOrCreate sur un index partiel, donc findFirst + create.
    const existing = await this.prisma.productWarehouse.findFirst({
      where: { productId, warehouseId, productVariantId: null },
      select: STOCK_SELECT,
    });

    if (existing) {
      return toStockEntry(existing);
    }

    const created = await this.prisma.productWarehouse.create({
      data: {
        productId,
        warehouseId,
        quantity: quantity ?? new Decimal(0),
        version: 0,
      },
      select: STOCK_SELECT,
    });

    return toStockEntry(created);
  }

  /**
   * Somme des quantités d'un produit sur tous les entrepôts de l'organisation.
   */
  async getStockSummary(
    productId: string,
    organizationId: string,
  ): Promise<StockSummary> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { organizationId: true, deletedAt: true },
    });

    if (!product || product.deletedAt !== null) {
      throw new NotFoundException('Produit introuvable.');
    }
    if (product.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const rows = await this.prisma.productWarehouse.findMany({
      where: { productId },
      select: STOCK_SELECT,
    });

    const entries = rows.map(toStockEntry);
    const totalQuantity = entries.reduce(
      (sum, e) => sum.plus(e.quantity),
      new Decimal(0),
    );

    return { productId, totalQuantity, byWarehouse: entries };
  }

  /**
   * Ajuste la quantité d'un ProductWarehouse dans la transaction fournie, avec verrouillage
   * optimiste sur la colonne version (§17 point B).
   *
   * NON exposé via HTTP — à appeler depuis une transaction Serializable (POS, ajustement S21).
   *
   * @throws OptimisticLockException si la version en base diffère de expectedVersion.
   */
  async adjustStock(
    tx: Prisma.TransactionClient,
    productWarehouseId: string,
    delta: Decimal,
    expectedVersion: number,
  ): Promise<{
    id: string;
    productId: string;
    productVariantId: string | null;
    warehouseId: string;
    quantity: Decimal;
    version: number;
  }> {
    const current = await tx.productWarehouse.findUnique({
      where: { id: productWarehouseId },
      select: { version: true },
    });

    if (!current) {
      throw new NotFoundException('Stock introuvable.');
    }

    if (current.version !== expectedVersion) {
      throw new OptimisticLockException(
        productWarehouseId,
        expectedVersion,
        current.version,
      );
    }

    return tx.productWarehouse.update({
      where: { id: productWarehouseId },
      data: {
        quantity: { increment: delta },
        version: { increment: 1 },
      },
      select: {
        id: true,
        productId: true,
        productVariantId: true,
        warehouseId: true,
        quantity: true,
        version: true,
      },
    });
  }
}
