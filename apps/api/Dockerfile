# ── Builder ──────────────────────────────────────────────────────────────────
# Tout se fait DANS ce conteneur Linux : install pnpm, génération Prisma, build tsc.
# Jamais de node_modules copié depuis l'hôte Windows (symlinks pnpm absolus incompatibles
# Linux) et jamais npm (projet pnpm exclusivement) — seul corepack (fourni par l'image
# node officielle) active pnpm, sans dépendre du registre npm pour l'outil lui-même.
#
# Install complet (non filtré) : @ensemb/utils est importé par apps/api sans être déclaré
# dans son package.json (résolu par hoisting pnpm sur un install complet, comme dans le
# reste du monorepo) — un install limité par --filter casse cette résolution. La stage
# runner copie donc l'arbre node_modules complet plutôt que d'utiliser `pnpm deploy` (qui
# ne suit que les dépendances déclarées et exclurait silencieusement @ensemb/utils).
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo

COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Génère le client Prisma DANS ce conteneur Linux/musl (jamais sur l'hôte, même en CI
# Windows) : le moteur natif téléchargé par `prisma generate` correspond à la plateforme
# qui l'exécute — exécuté ici, il produit le moteur Alpine (musl) attendu par
# `node:20-alpine`, jamais un .dll Windows.
RUN pnpm --filter=@ensemb/database run db:generate

# packages/utils doit être compilé avant apps/api : son package.json pointe vers
# ./dist/index.js (pas de résolution vers les sources TS).
RUN pnpm --filter=@ensemb/utils run build
RUN pnpm --filter=@ensemb/api run build

# ── Runner ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /repo

ENV NODE_ENV=production

# Requis par le moteur Prisma au démarrage : sans le binaire `openssl`, la détection runtime
# de la version d'OpenSSL installée échoue et le moteur charge à tort la variante liée à
# OpenSSL 1.1 (absente d'Alpine 3.17+, qui embarque OpenSSL 3.0) au lieu de la variante
# linux-musl-openssl-3.0.x générée pour cette cible (cf. schema.prisma).
RUN apk add --no-cache openssl

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nestjs

# node_modules complet (racine + hoisting pnpm) nécessaire à la résolution de
# @ensemb/utils par apps/api (cf. commentaire du stage builder).
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/api ./apps/api
COPY --from=builder /repo/packages ./packages

WORKDIR /repo/apps/api
USER nestjs

EXPOSE 3000

CMD ["node", "dist/main.js"]
