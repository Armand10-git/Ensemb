-- S28 — Devis (§18.4) : mirror exact de l'en-tête/ligne du domaine Vente (Sale/SaleDetail,
-- migration 20260726162317_add_sale), avec Sale.quotationId comme lien de conversion
-- (un devis se convertit en AU PLUS une vente — contrainte UNIQUE sur sales.quotationId).
--
-- Écarts volontaires par rapport au mirror Sale, tous documentés dans le plan de session :
--   - PAS de paidAmount/paymentStatus : un devis n'est jamais payé, aucun cycle de paiement
--     tant qu'il reste un devis (le paiement n'existera qu'après conversion en Sale, via le
--     PaymentSale déjà en place depuis S20).
--   - PAS de isPos/cashSessionId : un devis n'est jamais un encaissement POS direct.
--   - PAS de cancelReason/cancelledAt/cancelledById : l'annulation d'un devis n'est pas
--     implémentée dans cette session (pas de mouvement financier ni de stock à défaire —
--     un devis ne mouvemente jamais le stock, à aucun moment de son cycle de vie). Même
--     réserve que pour Purchase (S25) et SaleReturn/PurchaseReturn (S26) : ces colonnes
--     n'arriveront qu'avec une session dédiée si le besoin apparaît.
--
-- NOTE (à signaler, cf. rapport de session) : comme pour 20260728090000_add_cash_session,
-- 20260802100000_add_purchase et 20260802150000_add_returns, cette migration a été écrite à
-- la main puis appliquée via `prisma migrate deploy` plutôt que `prisma migrate dev` —
-- `migrate dev` échoue dès le replay de 20260727100000_add_payment_sale_fields sur la shadow
-- database (`ERROR: type "DocumentType" does not exist`), dette pré-existante déjà
-- documentée dans les migrations précédentes et non résolue ici (aucune modification à
-- l'historique existant, hors périmètre de cette session).

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "taxRate" DECIMAL(14,3) DEFAULT 0,
    "taxAmount" DECIMAL(14,3) DEFAULT 0,
    "discount" DECIMAL(14,3) DEFAULT 0,
    "shipping" DECIMAL(14,3) DEFAULT 0,
    "grandTotal" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_details" (
    "id" UUID NOT NULL,
    "quotationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productVariantId" UUID,
    "quoteUnitId" UUID,
    "price" DECIMAL(14,3) NOT NULL,
    "taxAmount" DECIMAL(14,3) DEFAULT 0,
    "taxMethod" TEXT DEFAULT 'percentage',
    "discount" DECIMAL(14,3) DEFAULT 0,
    "discountMethod" TEXT DEFAULT 'percentage',
    "quantity" DECIMAL(14,3) NOT NULL,
    "total" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "quotation_details_pkey" PRIMARY KEY ("id")
);

-- AlterTable : lien de conversion devis -> vente (S28). Un devis se convertit en AU PLUS une
-- vente : l'unicité est posée via un index unique (équivalent SQL de @unique sur une colonne
-- Prisma nullable), pas via une contrainte UNIQUE nommée sur la colonne elle-même.
ALTER TABLE "sales" ADD COLUMN "quotationId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "sales_quotationId_key" ON "sales"("quotationId");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organizationId_reference_key" ON "quotations"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "quotations_organizationId_status_idx" ON "quotations"("organizationId", "status");

-- CreateIndex
CREATE INDEX "quotations_organizationId_userId_idx" ON "quotations"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "quotations_organizationId_clientId_idx" ON "quotations"("organizationId", "clientId");

-- CreateIndex
CREATE INDEX "quotations_organizationId_warehouseId_idx" ON "quotations"("organizationId", "warehouseId");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_details" ADD CONSTRAINT "quotation_details_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_details" ADD CONSTRAINT "quotation_details_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
