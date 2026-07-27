-- S20 — Complète le stub PaymentSale (id/saleId/createdAt) posé en S19 : ajoute les
-- colonnes métier (organizationId dénormalisé, userId, date, reference, amount, method,
-- change, notes, updatedAt) permettant l'enregistrement des paiements de vente et le
-- recalcul de Sale.paidAmount/paymentStatus (§18.5). Table vide à ce stade (aucun service
-- ne l'utilisait avant S20) : colonnes NOT NULL ajoutées directement, sans DEFAULT ni
-- backfill nécessaire.

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER');

-- AlterEnum : PAYMENT_SALE — séquence globale par organisation pour la référence des
-- paiements de vente (format PAY-YYYY-NNNNNN), générée par DocumentCounterService.
ALTER TYPE "DocumentType" ADD VALUE 'PAYMENT_SALE';

-- AlterTable
ALTER TABLE "payment_sales" ADD COLUMN     "organizationId" UUID NOT NULL,
ADD COLUMN     "userId" UUID NOT NULL,
ADD COLUMN     "date" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "reference" TEXT NOT NULL,
ADD COLUMN     "amount" DECIMAL(14,3) NOT NULL,
ADD COLUMN     "method" "PaymentMethod" NOT NULL,
ADD COLUMN     "change" DECIMAL(14,3) DEFAULT 0,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "payment_sales_organizationId_saleId_idx" ON "payment_sales"("organizationId", "saleId");

-- AddForeignKey
ALTER TABLE "payment_sales" ADD CONSTRAINT "payment_sales_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_sales" ADD CONSTRAINT "payment_sales_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
