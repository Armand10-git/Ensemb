-- S31 — Agrégateur de paiement (Agent 1/4) : identifiants d'agrégateur (CinetPay/Monetbil-like)
-- PAR ORGANISATION. Un seul compte marchand par tenant route CARD/Orange Money/MTN MoMo — le
-- provider réellement utilisé n'est connu qu'au retour du webhook (choix fait par le client sur
-- la page hébergée de l'agrégateur), voir enum PaymentProvider ci-dessous, réutilisée par les
-- agents suivants pour PaymentWithCreditCard.provider. Distinct des identifiants plateforme de
-- PaymentAggregatorService (T07) et de l'enum PaymentMethod existante (moyens d'encaissement
-- POS/hors-POS, S20).
--
-- apiKeyCipher et webhookSecretCipher sont chiffrés en AES-256-GCM côté application
-- (EncryptionService, format "iv:authTag:ciphertext") avant écriture — jamais de secret en
-- clair en base (§17 point S).
--
-- NOTE (à signaler, cf. rapport de session) : comme pour 20260728090000_add_cash_session,
-- 20260802100000_add_purchase, 20260802150000_add_returns, 20260803090000_add_quotation et
-- 20260804090000_add_expense, cette migration a été écrite à la main puis appliquée via
-- `prisma migrate deploy` plutôt que `prisma migrate dev` — `migrate dev` échoue dès le replay
-- de l'historique sur la shadow database (dette pré-existante : `ALTER TYPE "DocumentType" ADD
-- VALUE` dans 20260727100000_add_payment_sale_fields alors qu'aucune migration ne contient
-- `CREATE TYPE "DocumentType"`, cf. note dans 20260728090000_add_cash_session). Aucune
-- modification n'a été faite à l'historique existant.

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('CARD', 'ORANGE_MONEY', 'MTN_MOMO');

-- CreateTable
CREATE TABLE "payment_gateway_credentials" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "apiKeyCipher" TEXT NOT NULL,
    "merchantId" TEXT,
    "webhookSecretCipher" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_gateway_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_credentials_organizationId_key" ON "payment_gateway_credentials"("organizationId");

-- AddForeignKey
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
