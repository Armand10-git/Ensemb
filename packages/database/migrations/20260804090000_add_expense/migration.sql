-- S29 — Dépenses (Expense/ExpenseCategory) : mirror structurel simple de Category/Brand
-- (référentiel tenant, soft delete uniquement, pas d'index dédié au-delà de la PK) pour
-- expense_categories, et mirror léger de Sale/Purchase pour expenses (reference générée
-- via DocumentCounterService, DocumentType.EXPENSE, préfixe "DEP").
--
-- Écart volontaire par rapport aux modules documentaires S19-S28 (Sale/Purchase/Quotation/
-- SaleReturn/PurchaseReturn) : Expense est un CRUD simple, sans colonne "status" ni cycle
-- de vie PENDING/COMPLETED/CANCELLED, sans mouvement de stock et sans paiement partiel —
-- une dépense est un fait comptable unique et immédiat, pas un document qui se valide ou
-- se solde progressivement. amount est donc NOT NULL (montant final connu à la création),
-- contrairement à grandTotal sur les documents de vente/achat qui démarre à 0 et se calcule
-- au fil des lignes.
--
-- Pas de RLS ajoutée : comme sales/purchases/quotations, expenses et expense_categories
-- restent hors périmètre RLS (seules users/roles en ont — pilote jamais étendu, §17).
--
-- NOTE (à signaler, cf. rapport de session) : comme pour 20260728090000_add_cash_session,
-- 20260802100000_add_purchase, 20260802150000_add_returns et 20260803090000_add_quotation,
-- cette migration a été écrite à la main puis appliquée via `prisma migrate deploy` plutôt
-- que `prisma migrate dev` — `migrate dev` échoue dès le replay de
-- 20260727100000_add_payment_sale_fields sur la shadow database (`ERROR: type
-- "DocumentType" does not exist`), dette pré-existante déjà documentée dans les migrations
-- précédentes et non résolue ici (aucune modification à l'historique existant, hors
-- périmètre de cette session).

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'EXPENSE';

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expenseCategoryId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "details" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- Index unique partiel : nom de catégorie de dépense actif unique par org (soft-deleted
-- exclus — §17 point 7, mirror exact "unique_brand_name_active"/"unique_category_name_active"
-- de 20260720111122_add_category_brand). Non représentable dans schema.prisma (limitation
-- Prisma sur les index partiels), raw SQL uniquement, comme pour Category/Brand.
CREATE UNIQUE INDEX "unique_expense_category_name_active"
  ON "expense_categories" ("organizationId", "name")
  WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "expenses_organizationId_reference_key" ON "expenses"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "expenses_organizationId_expenseCategoryId_idx" ON "expenses"("organizationId", "expenseCategoryId");

-- CreateIndex
CREATE INDEX "expenses_organizationId_warehouseId_idx" ON "expenses"("organizationId", "warehouseId");

-- CreateIndex
CREATE INDEX "expenses_organizationId_date_idx" ON "expenses"("organizationId", "date");

-- CreateIndex
CREATE INDEX "expenses_organizationId_userId_idx" ON "expenses"("organizationId", "userId");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
