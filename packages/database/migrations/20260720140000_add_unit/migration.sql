-- AlterTable : ajout des colonnes unit FK sur le stub Product (S11)
ALTER TABLE "products" ADD COLUMN "unitId"         UUID,
                        ADD COLUMN "unitPurchaseId" UUID,
                        ADD COLUMN "unitSaleId"     UUID;

-- CreateTable
CREATE TABLE "units" (
    "id"             UUID            NOT NULL,
    "organizationId" UUID            NOT NULL,
    "name"           TEXT            NOT NULL,
    "shortName"      TEXT            NOT NULL,
    "baseUnitId"     UUID,
    "operator"       TEXT            NOT NULL DEFAULT '*',
    "operatorValue"  DECIMAL(14,6)   NOT NULL DEFAULT 1,
    "deletedAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (auto-référence hiérarchie)
ALTER TABLE "units" ADD CONSTRAINT "units_baseUnitId_fkey"
  FOREIGN KEY ("baseUnitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products" ADD CONSTRAINT "products_unitSaleId_fkey"
  FOREIGN KEY ("unitSaleId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products" ADD CONSTRAINT "products_unitPurchaseId_fkey"
  FOREIGN KEY ("unitPurchaseId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index unique partiel : nom actif unique par org (soft-deleted exclus — §17 point 7).
CREATE UNIQUE INDEX "unique_unit_name_active"
  ON "units" ("organizationId", "name")
  WHERE "deletedAt" IS NULL;

-- Index unique partiel : nom court actif unique par org.
CREATE UNIQUE INDEX "unique_unit_short_name_active"
  ON "units" ("organizationId", "shortName")
  WHERE "deletedAt" IS NULL;
