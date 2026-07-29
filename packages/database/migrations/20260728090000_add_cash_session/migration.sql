-- S23b — Session de caisse (§18.2) : ouverture/clôture avec fond de caisse et écart
-- de comptage. "Chacun sa caisse" : une seule session OPEN par (organizationId, userId),
-- imposée par un index unique partiel (Prisma ne supporte pas les index partiels dans
-- @@unique — patron identique à unique_category_name_active, migration 20260720111122).
--
-- NOTE (à signaler, cf. rapport de session) : cette migration a été écrite à la main puis
-- appliquée via `prisma migrate deploy` plutôt que `prisma migrate dev`, car le replay de
-- l'historique de migrations sur la shadow database échoue déjà AVANT ce changement :
-- 20260727100000_add_payment_sale_fields exécute `ALTER TYPE "DocumentType" ADD VALUE`
-- alors qu'aucune migration de l'historique ne contient `CREATE TYPE "DocumentType"` ni
-- `CREATE TABLE "document_counters"` (introspection de la DB locale confirme que ces deux
-- objets existent réellement en base, donc créés hors migration — probablement via
-- `prisma db push` lors d'une session antérieure). Cette dette pré-existante bloque
-- `migrate dev`/`--create-only` pour quiconque tant qu'une migration de baseline n'a pas
-- été ajoutée ; aucune modification n'a été faite ici à l'historique existant.

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'CASH_SESSION';

-- AlterTable
ALTER TABLE "sales" ADD COLUMN "cashSessionId" UUID;

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id"                    UUID          NOT NULL DEFAULT gen_random_uuid(),
    "organizationId"        UUID          NOT NULL,
    "reference"             TEXT          NOT NULL,
    "warehouseId"           UUID          NOT NULL,
    "userId"                UUID          NOT NULL,
    "openingAmount"         DECIMAL(14,3) NOT NULL,
    "expectedClosingAmount" DECIMAL(14,3),
    "countedClosingAmount"  DECIMAL(14,3),
    "variance"              DECIMAL(14,3),
    "status"                TEXT          NOT NULL DEFAULT 'OPEN',
    "notes"                 TEXT,
    "openedAt"              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"              TIMESTAMP(3),

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_cashSessionId_fkey"
    FOREIGN KEY ("cashSessionId") REFERENCES "cash_sessions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Référence unique par organisation (patron DocumentCounter, §17 point X)
CREATE UNIQUE INDEX "cash_sessions_organizationId_reference_key"
  ON "cash_sessions"("organizationId", "reference");

CREATE INDEX "cash_sessions_organizationId_userId_status_idx"
  ON "cash_sessions"("organizationId", "userId", "status");

CREATE INDEX "sales_organizationId_cashSessionId_idx"
  ON "sales"("organizationId", "cashSessionId");

-- Index unique partiel : une seule session OPEN par (organizationId, userId) — "chacun sa
-- caisse" (§14). Patron identique à unique_category_name_active (migration 20260720111122).
CREATE UNIQUE INDEX "cash_sessions_org_user_open_key"
  ON "cash_sessions"("organizationId", "userId")
  WHERE "status" = 'OPEN';
