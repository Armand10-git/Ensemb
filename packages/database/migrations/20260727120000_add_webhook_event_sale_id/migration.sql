-- S22 — PosModule : webhook mobile money POS. Ajoute saleId à WebhookEvent, en parallèle
-- d'invoiceId, pour résoudre la vente concernée depuis le payload de l'agrégateur
-- (contrainte d'unicité (provider, providerEventId) déjà en place — §17 point V).

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "saleId" UUID;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
