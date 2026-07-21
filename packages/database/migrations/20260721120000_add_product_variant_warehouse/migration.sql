-- S14 — Product complet + ProductVariant + ProductWarehouse (Bloc D)

-- Suppression des produits stub sans categoryId (table sans données métier en dev)
DELETE FROM "products" WHERE "categoryId" IS NULL;

-- ── AlterTable products : colonnes métier ─────────────────────────────────────

ALTER TABLE "products"
  ADD COLUMN "code"        TEXT            NOT NULL DEFAULT '',
  ADD COLUMN "barcodeType" TEXT,
  ADD COLUMN "name"        TEXT            NOT NULL DEFAULT '',
  ADD COLUMN "cost"        DECIMAL(14,3)   NOT NULL DEFAULT 0,
  ADD COLUMN "price"       DECIMAL(14,3)   NOT NULL DEFAULT 0,
  ADD COLUMN "taxRate"     DECIMAL(5,4)    NOT NULL DEFAULT 0,
  ADD COLUMN "taxMethod"   TEXT            NOT NULL DEFAULT 'percentage',
  ADD COLUMN "image"       TEXT,
  ADD COLUMN "note"        TEXT,
  ADD COLUMN "stockAlert"  INTEGER         NOT NULL DEFAULT 0,
  ADD COLUMN "isVariant"   BOOLEAN         NOT NULL DEFAULT false,
  ADD COLUMN "isActive"    BOOLEAN         NOT NULL DEFAULT true,
  ADD COLUMN "createdAt"   TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt"   TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Supprimer les DEFAULT temporaires (valeurs portées par Prisma Client, pas la DB)
ALTER TABLE "products"
  ALTER COLUMN "code" DROP DEFAULT,
  ALTER COLUMN "name" DROP DEFAULT;

-- categoryId : passer de nullable à NOT NULL (stub S10/S11 → métier S14)
-- Supprimer l'ancienne FK (ON DELETE SET NULL, incompatible avec NOT NULL)
ALTER TABLE "products" DROP CONSTRAINT "products_categoryId_fkey";
-- Rendre NOT NULL
ALTER TABLE "products" ALTER COLUMN "categoryId" SET NOT NULL;
-- Re-créer FK avec RESTRICT (categoryId non nullable → pas de SET NULL)
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- UniqueConstraint (organizationId, code) — actifs et supprimés (code non libéré par soft-delete)
ALTER TABLE "products" ADD CONSTRAINT "products_organizationId_code_key"
  UNIQUE ("organizationId", "code");

-- Index unique partiel : nom actif unique par org (§17 point 7)
CREATE UNIQUE INDEX "unique_product_name_active"
  ON "products" ("organizationId", "name")
  WHERE "deletedAt" IS NULL;

-- ── CreateTable : product_variants ────────────────────────────────────────────

CREATE TABLE "product_variants" (
  "id"        UUID        NOT NULL,
  "productId" UUID        NOT NULL,
  "name"      TEXT,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── CreateTable : product_warehouse ───────────────────────────────────────────
-- version INT : verrouillage optimiste géré en S15 (§17 point B)
-- quantity DECIMAL obligatoire — jamais Float (§17 point A)
-- Note PostgreSQL : NULLs distincts dans UNIQUE — deux lignes (p,w,NULL) sont autorisées.
-- La contrainte @@unique Prisma est traduite ici par deux index partiels pour éviter ce comportement.

CREATE TABLE "product_warehouse" (
  "id"               UUID          NOT NULL,
  "productId"        UUID          NOT NULL,
  "warehouseId"      UUID          NOT NULL,
  "productVariantId" UUID,
  "quantity"         DECIMAL(14,3) NOT NULL DEFAULT 0,
  "version"          INTEGER       NOT NULL DEFAULT 0,
  CONSTRAINT "product_warehouse_pkey" PRIMARY KEY ("id")
);

-- Unicité (productId, warehouseId) pour les produits sans variante
CREATE UNIQUE INDEX "product_warehouse_no_variant_unique"
  ON "product_warehouse" ("productId", "warehouseId")
  WHERE "productVariantId" IS NULL;

-- Unicité (productId, warehouseId, productVariantId) pour les produits avec variante
CREATE UNIQUE INDEX "product_warehouse_with_variant_unique"
  ON "product_warehouse" ("productId", "warehouseId", "productVariantId")
  WHERE "productVariantId" IS NOT NULL;

ALTER TABLE "product_warehouse" ADD CONSTRAINT "product_warehouse_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_warehouse" ADD CONSTRAINT "product_warehouse_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_warehouse" ADD CONSTRAINT "product_warehouse_productVariantId_fkey"
  FOREIGN KEY ("productVariantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
