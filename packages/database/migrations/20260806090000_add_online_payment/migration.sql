-- S31 — Agrégateur de paiement : intention de paiement en ligne sur vente classique
-- (OnlinePaymentIntent) et mapping paiement↔compte agrégateur (PaymentWithCreditCard).
--
-- Décision de conception (§17 point V, actée dans le plan S31) : une vente classique
-- décrémente son stock à validate() (S21), totalement découplée de l'encaissement (S20) —
-- il n'y a donc rien à restituer côté stock si un paiement en ligne échoue ou expire.
-- OnlinePaymentIntent porte cette attente (PENDING/CONFIRMED/EXPIRED), jamais Sale.status
-- (qui resterait AWAITING_PAYMENT-capable pour le POS uniquement) : un document Sale COMPLETED
-- reste immuable (§17 règle 7), et un Sale PENDING n'est pas affecté par ce flux non plus.
-- PaymentSale n'est créé qu'à la confirmation webhook.
--
-- PaymentWithCreditCard.provider (CARD/ORANGE_MONEY/MTN_MOMO, enum posée par la migration
-- 20260805090000_add_payment_gateway_credential) est renseigné depuis le payload webhook —
-- un seul compte agrégateur par organisation, le moyen réel n'est connu qu'au retour.
--
-- webhook_events.onlinePaymentIntentId : même patron de FK nullable en parallèle que saleId
-- (POS, S22) et invoiceId (SaaS, T07).
--
-- NOTE (comme les migrations précédentes depuis 20260728090000_add_cash_session) : générée
-- via `prisma migrate diff --from-url ... --to-schema-datamodel schema.prisma --script` puis
-- appliquée avec `prisma migrate deploy` — `prisma migrate dev` échoue au replay sur la shadow
-- database (dette pré-existante documentée dans 20260728090000_add_cash_session, sans lien
-- avec cette migration). Aucune modification de l'historique existant.

-- CreateEnum
CREATE TYPE "OnlinePaymentIntentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED');

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "onlinePaymentIntentId" UUID;

-- CreateTable
CREATE TABLE "online_payment_intents" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "status" "OnlinePaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentSaleId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_with_credit_card" (
    "id" UUID NOT NULL,
    "paymentSaleId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerCustomerId" TEXT NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_with_credit_card_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "online_payment_intents_paymentSaleId_key" ON "online_payment_intents"("paymentSaleId");

-- CreateIndex
CREATE INDEX "online_payment_intents_organizationId_saleId_idx" ON "online_payment_intents"("organizationId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_with_credit_card_paymentSaleId_key" ON "payment_with_credit_card"("paymentSaleId");

-- CreateIndex
CREATE INDEX "payment_with_credit_card_organizationId_idx" ON "payment_with_credit_card"("organizationId");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_onlinePaymentIntentId_fkey" FOREIGN KEY ("onlinePaymentIntentId") REFERENCES "online_payment_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payment_intents" ADD CONSTRAINT "online_payment_intents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payment_intents" ADD CONSTRAINT "online_payment_intents_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payment_intents" ADD CONSTRAINT "online_payment_intents_paymentSaleId_fkey" FOREIGN KEY ("paymentSaleId") REFERENCES "payment_sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_with_credit_card" ADD CONSTRAINT "payment_with_credit_card_paymentSaleId_fkey" FOREIGN KEY ("paymentSaleId") REFERENCES "payment_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_with_credit_card" ADD CONSTRAINT "payment_with_credit_card_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_with_credit_card" ADD CONSTRAINT "payment_with_credit_card_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
