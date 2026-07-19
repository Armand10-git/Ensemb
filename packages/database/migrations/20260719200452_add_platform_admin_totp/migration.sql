/*
  Warnings:

  - Added the required column `updatedAt` to the `platform_admins` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "platform_admins" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpSecret" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;
