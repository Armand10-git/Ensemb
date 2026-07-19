-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'JSON');

-- CreateTable
CREATE TABLE "backup_exports" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "format" "ExportFormat" NOT NULL DEFAULT 'CSV',
    "filename" TEXT,
    "sizeBytes" INTEGER,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "backup_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_exports_organizationId_requestedAt_idx" ON "backup_exports"("organizationId", "requestedAt" DESC);

-- AddForeignKey
ALTER TABLE "backup_exports" ADD CONSTRAINT "backup_exports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
