-- CreateTable : clients (S12 — Bloc C)
CREATE TABLE "clients" (
    "id"             UUID            NOT NULL,
    "organizationId" UUID            NOT NULL,
    "name"           TEXT            NOT NULL,
    "code"           INTEGER         NOT NULL,
    "email"          TEXT,
    "phone"          TEXT,
    "country"        TEXT,
    "city"           TEXT,
    "address"        TEXT,
    "deletedAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable : providers (S12 — Bloc C)
CREATE TABLE "providers" (
    "id"             UUID            NOT NULL,
    "organizationId" UUID            NOT NULL,
    "name"           TEXT            NOT NULL,
    "code"           INTEGER         NOT NULL,
    "email"          TEXT,
    "phone"          TEXT,
    "country"        TEXT,
    "city"           TEXT,
    "address"        TEXT,
    "deletedAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- UniqueConstraint : (organizationId, code) — filet de sécurité anti-collision concurrente
ALTER TABLE "clients"   ADD CONSTRAINT "clients_organizationId_code_key"   UNIQUE ("organizationId", "code");
ALTER TABLE "providers" ADD CONSTRAINT "providers_organizationId_code_key" UNIQUE ("organizationId", "code");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "providers" ADD CONSTRAINT "providers_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Index unique partiel : nom actif unique par org (soft-deleted exclus — §17 point 7)
CREATE UNIQUE INDEX "unique_client_name_active"
  ON "clients" ("organizationId", "name")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "unique_provider_name_active"
  ON "providers" ("organizationId", "name")
  WHERE "deletedAt" IS NULL;
