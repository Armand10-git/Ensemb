-- S25 — Domaine Achat fournisseur (§18.7) : mirror exact du domaine Vente
-- (Sale/SaleDetail/PaymentSale, migrations 20260726162317_add_sale et
-- 20260727100000_add_payment_sale_fields), en sens inverse (validate() incrémentera le
-- stock au lieu de le décrémenter — service S25 suivant). Contrairement à Sale, tout est
-- créé en une seule migration ici (pas de split S19/S20) car les trois tables et toutes
-- leurs colonnes métier sont livrées ensemble dans cette session.
--
-- NOTE (à signaler, cf. rapport de session) : comme pour 20260728090000_add_cash_session,
-- cette migration a été écrite à la main puis appliquée via `prisma migrate deploy` plutôt
-- que `prisma migrate dev` — `migrate dev` échoue dès le replay de
-- 20260727100000_add_payment_sale_fields sur la shadow database (`ERROR: type
-- "DocumentType" does not exist`), dette pré-existante déjà documentée dans
-- 20260728090000_add_cash_session et non résolue ici (aucune modification à l'historique
-- existant, hors périmètre de cette session).

-- AlterEnum : PAYMENT_PURCHASE — séquence globale par organisation pour la référence des
-- paiements d'achat (format PAA-YYYY-NNNNNN), générée par DocumentCounterService.
ALTER TYPE "DocumentType" ADD VALUE 'PAYMENT_PURCHASE';

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "taxRate" DECIMAL(14,3) DEFAULT 0,
    "taxAmount" DECIMAL(14,3) DEFAULT 0,
    "discount" DECIMAL(14,3) DEFAULT 0,
    "shipping" DECIMAL(14,3) DEFAULT 0,
    "grandTotal" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_details" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productVariantId" UUID,
    "purchaseUnitId" UUID,
    "price" DECIMAL(14,3) NOT NULL,
    "taxAmount" DECIMAL(14,3) DEFAULT 0,
    "taxMethod" TEXT DEFAULT 'percentage',
    "discount" DECIMAL(14,3) DEFAULT 0,
    "discountMethod" TEXT DEFAULT 'percentage',
    "quantity" DECIMAL(14,3) NOT NULL,
    "total" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "purchase_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_purchases" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "change" DECIMAL(14,3) DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchases_organizationId_reference_key" ON "purchases"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "purchases_organizationId_userId_idx" ON "purchases"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "purchases_organizationId_providerId_idx" ON "purchases"("organizationId", "providerId");

-- CreateIndex
CREATE INDEX "purchases_organizationId_warehouseId_idx" ON "purchases"("organizationId", "warehouseId");

-- CreateIndex
CREATE INDEX "purchases_organizationId_status_idx" ON "purchases"("organizationId", "status");

-- CreateIndex
CREATE INDEX "purchases_organizationId_paymentStatus_idx" ON "purchases"("organizationId", "paymentStatus");

-- CreateIndex
CREATE INDEX "payment_purchases_organizationId_purchaseId_idx" ON "payment_purchases"("organizationId", "purchaseId");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_details" ADD CONSTRAINT "purchase_details_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_details" ADD CONSTRAINT "purchase_details_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_purchases" ADD CONSTRAINT "payment_purchases_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_purchases" ADD CONSTRAINT "payment_purchases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_purchases" ADD CONSTRAINT "payment_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
