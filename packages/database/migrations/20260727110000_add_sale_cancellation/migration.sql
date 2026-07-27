-- S21b — Annulation d'une vente validée (§18.18, §17 point AC). Ajoute la raison
-- obligatoire, l'horodatage et l'acteur de l'annulation. cancelledById est nullable :
-- le job d'expiration mobile money (S22) annule une vente sans acteur HTTP (actorId null).

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" UUID;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
