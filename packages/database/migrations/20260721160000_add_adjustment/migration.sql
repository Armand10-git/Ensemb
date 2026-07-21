-- S16 — Ajustements de stock : Adjustment + AdjustmentDetail (Bloc D)

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "AdjustmentStatus" AS ENUM ('DRAFT', 'VALIDATED');
CREATE TYPE "AdjustmentDetailType" AS ENUM ('ADDITION', 'SOUSTRACTION');

-- ── Table adjustments ─────────────────────────────────────────────────────────

CREATE TABLE "adjustments" (
  "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID          NOT NULL,
  "reference"      TEXT          NOT NULL,
  "date"           TIMESTAMP(3)  NOT NULL,
  "warehouseId"    UUID          NOT NULL,
  "userId"         UUID          NOT NULL,
  "note"           TEXT,
  "status"         "AdjustmentStatus" NOT NULL DEFAULT 'DRAFT',
  "deletedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "adjustments_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Référence unique par organisation (index unique + soft delete géré applicativement)
CREATE UNIQUE INDEX "adjustments_organizationId_reference_key"
  ON "adjustments"("organizationId", "reference");

CREATE INDEX "adjustments_organizationId_status_idx"
  ON "adjustments"("organizationId", "status");

-- ── Table adjustment_details ──────────────────────────────────────────────────

CREATE TABLE "adjustment_details" (
  "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
  "adjustmentId"     UUID          NOT NULL,
  "productId"        UUID          NOT NULL,
  "productVariantId" UUID,
  "type"             "AdjustmentDetailType" NOT NULL,
  "quantity"         DECIMAL(14,3) NOT NULL,
  "unitCost"         DECIMAL(14,3) NOT NULL DEFAULT 0,

  CONSTRAINT "adjustment_details_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "adjustment_details"
  ADD CONSTRAINT "adjustment_details_adjustmentId_fkey"
    FOREIGN KEY ("adjustmentId") REFERENCES "adjustments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "adjustment_details"
  ADD CONSTRAINT "adjustment_details_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
