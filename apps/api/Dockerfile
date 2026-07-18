# ── Runner ───────────────────────────────────────────────────────────────────
# dist/ est buildé localement par pnpm (pnpm turbo build --filter=@ensemb/api).
# Les dépendances de production sont installées par npm à l'intérieur du conteneur
# (npm crée des node_modules plats, sans symlinks Windows absolus incompatibles Linux).
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nestjs

# Installer uniquement les dépendances de production avec npm
# (cache mount BuildKit : les packages ne sont téléchargés qu'une seule fois)
COPY apps/api/package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --ignore-scripts --legacy-peer-deps

# Artefacts compilés par tsc (produits localement)
COPY apps/api/dist ./dist

USER nestjs

EXPOSE 3000

CMD ["node", "dist/main.js"]
