-- Migration T03 : Row-Level Security (défense en profondeur multi-tenant)
--
-- Principe : app.current_tenant doit être posé via set_config(is_local=true) dans la
-- transaction — équivalent paramétrable de SET LOCAL (§17 point T, règle non négociable).
-- is_local=true garantit que la variable est effacée au commit : la connexion rendue au
-- pool n'expose pas le contexte tenant du tenant précédent.
--
-- Tables concernées : users, roles (portent "organizationId", modèles scopés).
-- Tables exclues : organizations, platform_admins, permissions, roles_on_users,
--   permissions_on_roles, audit_logs (organizationId nullable, accès admin-only).
--
-- Rôle applicatif : le user POSTGRES_USER (ensemb) est superuser → bypass RLS même
-- avec FORCE ROW LEVEL SECURITY. On crée ensemb_app (non-superuser) que l'app utilise
-- pour les requêtes soumises à RLS. Les migrations continuent avec ensemb (superuser).

-- ============================================================
-- Rôle applicatif non-superuser
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ensemb_app') THEN
    CREATE ROLE ensemb_app LOGIN PASSWORD 'ensemb_app_dev';
  END IF;
END
$$;

-- Permet à ensemb de SET ROLE ensemb_app (pratique pour les tests).
GRANT ensemb_app TO ensemb;

-- Droits sur les tables scopées
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users TO ensemb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE roles TO ensemb_app;

-- Droits sur les séquences éventuelles (Prisma utilise des UUID donc pas de serial,
-- mais on accorde tout de même pour couvrir les futures tables).
GRANT USAGE ON SCHEMA public TO ensemb_app;

-- ============================================================
-- TABLE : users
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- FORCE RLS : s'applique même au propriétaire de la table.
-- Note : les superusers (ensemb) contournent toujours RLS — c'est voulu pour les
-- migrations. L'app utilise ensemb_app qui y est soumis.
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- Policy fail-closed : set_config(is_local=true) doit avoir été appelé dans la transaction.
-- Si la variable n'est pas définie, current_setting retourne NULL → aucune ligne exposée.
-- NULLIF(..., '') convertit la chaîne vide en NULL quand la variable n'est pas définie,
-- évitant l'erreur "invalid input syntax for type uuid". NULL::uuid = NULL → false → fail-closed.
CREATE POLICY tenant_isolation ON users
  USING ("organizationId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ============================================================
-- TABLE : roles
-- ============================================================
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON roles
  USING ("organizationId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
