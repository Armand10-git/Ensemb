-- AlterTable webhook_events
-- 1. Rename processedAt → receivedAt (horodatage de réception, pas de traitement)
-- 2. Add processedAt nullable (set after business processing completes)
-- 3. Add organizationId nullable (tenant scope, résolu via invoiceId)
ALTER TABLE "webhook_events" RENAME COLUMN "processedAt" TO "receivedAt";

ALTER TABLE "webhook_events" ADD COLUMN "processedAt" TIMESTAMP(3);

ALTER TABLE "webhook_events" ADD COLUMN "organizationId" UUID;
