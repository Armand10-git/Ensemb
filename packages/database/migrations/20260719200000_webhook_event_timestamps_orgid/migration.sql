-- AlterTable webhook_events
-- 1. Rename processed_at → received_at (horodatage de réception, pas de traitement)
-- 2. Add processed_at nullable (set after business processing completes)
-- 3. Add organization_id nullable (tenant scope, résolu via invoiceId)
ALTER TABLE "webhook_events" RENAME COLUMN "processed_at" TO "received_at";

ALTER TABLE "webhook_events" ADD COLUMN "processed_at" TIMESTAMP(3);

ALTER TABLE "webhook_events" ADD COLUMN "organization_id" UUID;
