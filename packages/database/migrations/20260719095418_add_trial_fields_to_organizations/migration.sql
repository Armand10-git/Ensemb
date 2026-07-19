-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "trialEndedReason" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);
