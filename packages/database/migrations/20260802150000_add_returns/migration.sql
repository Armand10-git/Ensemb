-- S26 — Retours de vente et d'achat (§18.6) : mirror exact du domaine Vente/Achat
-- (Sale/SaleDetail/PaymentSale — migrations 20260726162317_add_sale et
-- 20260727100000_add_payment_sale_fields ; Purchase/PurchaseDetail/PaymentPurchase —
-- migration 20260802100000_add_purchase), avec en plus la ligne d'origine précise
-- (saleDetailId / purchaseDetailId) sur chaque ligne de retour, nécessaire pour borner la
-- quantité retournable cumulée et pour la vérification anti-IDOR (une ligne de retour doit
-- référencer une ligne qui appartient bien au document déclaré — vérifié en application,
-- services des agents suivants).
--
-- NOTE (à signaler, cf. rapport de session) : comme pour 20260728090000_add_cash_session et
-- 20260802100000_add_purchase, cette migration a été écrite à la main puis appliquée via
-- `prisma migrate deploy` plutôt que `prisma migrate dev` — `migrate dev` échoue dès le
-- replay de 20260727100000_add_payment_sale_fields sur la shadow database (`ERROR: type
-- "DocumentType" does not exist`), dette pré-existante déjà documentée dans les migrations
-- précédentes et non résolue ici (aucune modification à l'historique existant, hors
-- périmètre de cette session).

-- AlterEnum : PAYMENT_RETURN — séquence globale par organisation pour la référence des
-- paiements (remboursements) de retour (format REM-YYYY-NNNNNN), générée par
-- DocumentCounterService.
ALTER TYPE "DocumentType" ADD VALUE 'PAYMENT_RETURN';

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
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

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_details" (
    "id" UUID NOT NULL,
    "saleReturnId" UUID NOT NULL,
    "saleDetailId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productVariantId" UUID,
    "returnUnitId" UUID,
    "price" DECIMAL(14,3) NOT NULL,
    "taxAmount" DECIMAL(14,3) DEFAULT 0,
    "taxMethod" TEXT DEFAULT 'percentage',
    "discount" DECIMAL(14,3) DEFAULT 0,
    "discountMethod" TEXT DEFAULT 'percentage',
    "quantity" DECIMAL(14,3) NOT NULL,
    "total" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "sale_return_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
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

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_details" (
    "id" UUID NOT NULL,
    "purchaseReturnId" UUID NOT NULL,
    "purchaseDetailId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productVariantId" UUID,
    "returnUnitId" UUID,
    "price" DECIMAL(14,3) NOT NULL,
    "taxAmount" DECIMAL(14,3) DEFAULT 0,
    "taxMethod" TEXT DEFAULT 'percentage',
    "discount" DECIMAL(14,3) DEFAULT 0,
    "discountMethod" TEXT DEFAULT 'percentage',
    "quantity" DECIMAL(14,3) NOT NULL,
    "total" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "purchase_return_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_returns" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "saleReturnId" UUID,
    "purchaseReturnId" UUID,
    "userId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "change" DECIMAL(14,3) DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_returns_pkey" PRIMARY KEY ("id")
);

-- Contrainte d'invariant critique : exactement un des deux parents (saleReturnId,
-- purchaseReturnId) doit être renseigné. Défense en profondeur en plus de la vérification
-- applicative (services des agents suivants) — cf. philosophie RLS du projet (§17 point T) :
-- un invariant critique n'est jamais garanti uniquement côté application.
-- num_nonnulls() est la fonction PostgreSQL native prévue pour ce cas exact, préférée à un
-- cast booléen->entier moins lisible.
ALTER TABLE "payment_returns" ADD CONSTRAINT "payment_returns_exactly_one_parent_chk"
  CHECK (num_nonnulls("saleReturnId", "purchaseReturnId") = 1);

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_organizationId_reference_key" ON "sale_returns"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "sale_returns_organizationId_status_idx" ON "sale_returns"("organizationId", "status");

-- CreateIndex
CREATE INDEX "sale_returns_organizationId_paymentStatus_idx" ON "sale_returns"("organizationId", "paymentStatus");

-- CreateIndex
CREATE INDEX "sale_returns_organizationId_userId_idx" ON "sale_returns"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "sale_returns_organizationId_warehouseId_idx" ON "sale_returns"("organizationId", "warehouseId");

-- CreateIndex
CREATE INDEX "sale_returns_organizationId_saleId_idx" ON "sale_returns"("organizationId", "saleId");

-- CreateIndex
CREATE INDEX "sale_return_details_saleDetailId_idx" ON "sale_return_details"("saleDetailId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_organizationId_reference_key" ON "purchase_returns"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "purchase_returns_organizationId_status_idx" ON "purchase_returns"("organizationId", "status");

-- CreateIndex
CREATE INDEX "purchase_returns_organizationId_paymentStatus_idx" ON "purchase_returns"("organizationId", "paymentStatus");

-- CreateIndex
CREATE INDEX "purchase_returns_organizationId_userId_idx" ON "purchase_returns"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "purchase_returns_organizationId_warehouseId_idx" ON "purchase_returns"("organizationId", "warehouseId");

-- CreateIndex
CREATE INDEX "purchase_returns_organizationId_purchaseId_idx" ON "purchase_returns"("organizationId", "purchaseId");

-- CreateIndex
CREATE INDEX "purchase_return_details_purchaseDetailId_idx" ON "purchase_return_details"("purchaseDetailId");

-- CreateIndex
CREATE INDEX "payment_returns_organizationId_saleReturnId_idx" ON "payment_returns"("organizationId", "saleReturnId");

-- CreateIndex
CREATE INDEX "payment_returns_organizationId_purchaseReturnId_idx" ON "payment_returns"("organizationId", "purchaseReturnId");

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_details" ADD CONSTRAINT "sale_return_details_saleReturnId_fkey" FOREIGN KEY ("saleReturnId") REFERENCES "sale_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_details" ADD CONSTRAINT "sale_return_details_saleDetailId_fkey" FOREIGN KEY ("saleDetailId") REFERENCES "sale_details"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_details" ADD CONSTRAINT "sale_return_details_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_details" ADD CONSTRAINT "purchase_return_details_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "purchase_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_details" ADD CONSTRAINT "purchase_return_details_purchaseDetailId_fkey" FOREIGN KEY ("purchaseDetailId") REFERENCES "purchase_details"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_details" ADD CONSTRAINT "purchase_return_details_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_returns" ADD CONSTRAINT "payment_returns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_returns" ADD CONSTRAINT "payment_returns_saleReturnId_fkey" FOREIGN KEY ("saleReturnId") REFERENCES "sale_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_returns" ADD CONSTRAINT "payment_returns_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "purchase_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_returns" ADD CONSTRAINT "payment_returns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
