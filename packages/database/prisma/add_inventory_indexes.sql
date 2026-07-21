CREATE INDEX IF NOT EXISTS "idx_products_org" ON products ("organizationId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_clients_org" ON clients ("organizationId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_providers_org" ON providers ("organizationId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_categories_org" ON categories ("organizationId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_brands_org" ON brands ("organizationId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_units_org" ON units ("organizationId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_warehouses_org" ON warehouses ("organizationId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_product_warehouse_product" ON product_warehouse ("productId");
CREATE INDEX IF NOT EXISTS "idx_product_warehouse_warehouse" ON product_warehouse ("warehouseId");