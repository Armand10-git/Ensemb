-- Migration S18 : ajout du modèle Notification persistant (§17 point I)
-- Crée la table notifications + index composite pour requêtes paginées par org/user/readAt

CREATE TABLE "notifications" (
    "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID        NOT NULL,
    "userId"         UUID        NOT NULL,
    "type"           TEXT        NOT NULL,
    "payload"        JSONB       NOT NULL,
    "readAt"         TIMESTAMPTZ,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "notifications_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "notifications_organizationId_userId_readAt_idx"
    ON "notifications"("organizationId", "userId", "readAt");
