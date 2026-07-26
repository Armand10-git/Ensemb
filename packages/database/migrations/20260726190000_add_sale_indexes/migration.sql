-- CreateIndex
CREATE INDEX "sales_organizationId_userId_idx" ON "sales"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "sales_organizationId_clientId_idx" ON "sales"("organizationId", "clientId");

-- CreateIndex
CREATE INDEX "sales_organizationId_warehouseId_idx" ON "sales"("organizationId", "warehouseId");

