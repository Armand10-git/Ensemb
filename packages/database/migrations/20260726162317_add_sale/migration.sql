-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'PARTIAL', 'UNPAID');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'AWAITING_PAYMENT', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "isPos" BOOLEAN NOT NULL DEFAULT false,
    "userId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "taxRate" DECIMAL(14,3) DEFAULT 0,
    "taxAmount" DECIMAL(14,3) DEFAULT 0,
    "discount" DECIMAL(14,3) DEFAULT 0,
    "shipping" DECIMAL(14,3) DEFAULT 0,
    "grandTotal" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_details" (
    "id" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productVariantId" UUID,
    "saleUnitId" UUID,
    "price" DECIMAL(14,3) NOT NULL,
    "taxAmount" DECIMAL(14,3) DEFAULT 0,
    "taxMethod" TEXT DEFAULT 'percentage',
    "discount" DECIMAL(14,3) DEFAULT 0,
    "discountMethod" TEXT DEFAULT 'percentage',
    "quantity" DECIMAL(14,3) NOT NULL,
    "total" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "sale_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_sales" (
    "id" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_sales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_organizationId_status_idx" ON "sales"("organizationId", "status");

-- CreateIndex
CREATE INDEX "sales_organizationId_paymentStatus_idx" ON "sales"("organizationId", "paymentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "sales_organizationId_reference_key" ON "sales"("organizationId", "reference");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_details" ADD CONSTRAINT "sale_details_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_details" ADD CONSTRAINT "sale_details_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_sales" ADD CONSTRAINT "payment_sales_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

