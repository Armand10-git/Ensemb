# Ensemb — ERP/POS SaaS multi-tenant (Cameroun)

Monorepo Turborepo : `apps/api` (NestJS + Prisma + PostgreSQL + Redis/BullMQ + Socket.io),
`apps/web` (React + TanStack Router/Query + shadcn/ui + Tailwind), `apps/mobile` (Expo),
`packages/ui`, `packages/validation` (schémas zod partagés), `packages/types`.

## Méthode de travail (impératif)

- Une conversation = **une session** du plan `docs/roadmap/04-sessions.md` (S01…S52b, T01…T10).
- Ne lis QUE les fichiers cités par le prompt de session. Ne lis jamais un fichier `docs/` en entier
  si une section suffit — cherche le titre (`§`, `[18.x]`, `Sxx`) et lis autour.
- Chaque session a un critère « Fait quand » : la session n'est terminée que lorsqu'il est vérifié
  (test ou démonstration), lint et build verts.
- En cas de conflit entre le code existant et `docs/`, signale-le — ne tranche pas silencieusement.

## Règles d'architecture non négociables (détail : docs/roadmap/02-plan-et-decisions.md, §17)

1. **Argent & quantités = `Decimal`** (jamais `Float`), calculs finaux côté serveur uniquement.
2. **`organizationId` partout** : tout modèle métier est scopé tenant dès sa création ; requêtes
   auto-scopées + RLS PostgreSQL en défense en profondeur.
3. **RLS + pool** : `app.current_tenant` posé en `SET LOCAL` **dans la transaction** — jamais `SET` session.
4. **Références** : via `DocumentCounter` incrémenté dans la transaction de création — jamais « max + 1 ».
5. **Stock** : une seule source de vérité (`ProductWarehouse`), verrouillage optimiste (`version`,
   transaction `Serializable`) sur tout mouvement. Optimistic UI interdit sur le stock.
6. **Statuts dérivés** : `UNPAID/PARTIAL/PAID` calculés depuis les paiements, jamais saisis.
7. **Soft delete** + index uniques partiels (`WHERE deleted_at IS NULL`) ; les documents financiers
   s'annulent (`CANCELLED`, restitution stock, permission dédiée), ne se suppriment pas.
8. **Webhooks idempotents** (`WebhookEvent`, unicité `provider+providerEventId`) ; paiement mobile
   money = flux asynchrone `AWAITING_PAYMENT` → webhook ou expiration avec restitution.
9. **Secrets tenant chiffrés** en base (AES-256-GCM, clé `APP_ENCRYPTION_KEY` en env).
10. **Mutations sensibles → `AuditLog`** (interceptor global).
11. **API préfixée `/api/v1`** ; validation zod partagée client/serveur (`packages/validation`).
12. **Jobs BullMQ** dans un process worker dédié ; tout job transporte son `organizationId`.

## Sécurité obligatoire — par classe d'attaque (aucune exception, aucune session)

- **Injection** : accès données via Prisma paramétré uniquement ; `$queryRaw` en template taggé,
  jamais de SQL concaténé. Toute entrée validée par zod en liste blanche ; DTO explicites — le mass
  assignment (spread du body vers Prisma) est interdit.
- **IDOR / contrôle d'accès** : tout accès à une ressource vérifie `organizationId` ET la permission,
  côté serveur, même si l'UI a déjà filtré. Un ID fourni par le client n'est jamais digne de confiance.
- **XSS** : échappement React par défaut ; `dangerouslySetInnerHTML` interdit sauf contenu sanitisé
  et justifié en commentaire. Helmet actif (CSP, HSTS, nosniff) ; CORS en liste blanche de sous-domaines.
- **CSRF** : auth par Bearer token (pas de cookie de session) ; si un cookie devient nécessaire :
  `SameSite=Strict` + token anti-CSRF.
- **Force brute / énumération** : rate limiting (`@nestjs/throttler`) sur login, reset, endpoints
  publics `by-subdomain` ; réponses neutres sur le reset (ne jamais révéler l'existence d'un compte).
- **Uploads** : type vérifié sur les octets réels (magic bytes), pas l'extension ; taille plafonnée ;
  images ré-encodées via `sharp` ; livraison par URL signée, jamais d'exécution depuis le stockage.
- **SSRF** : aucune URL fournie par un utilisateur n'est requêtée côté serveur hors liste blanche.
- **Fuites** : aucune stack trace ni détail interne dans les réponses en production ; aucun secret ni
  PII dans les logs ; les erreurs 500 sont journalisées côté serveur, génériques côté client.
- **Sessions** : access token court + refresh avec rotation et révocation (blacklist Redis) ;
  changement de mot de passe = révocation des autres sessions.
- **Chaîne d'approvisionnement** : lockfile respecté, `npm audit` dans la CI, aucune dépendance
  ajoutée sans justification dans le plan de session.

## Qualité de code — « fonctionnel » ne suffit jamais

- **Definition of done** : lisible, typé strict (TypeScript `strict`, `any` interdit sauf justification
  commentée), lint et build verts, testé selon la session — sinon la session n'est pas terminée.
- **Chaque fonction est documentée** : utilité, paramètres, retour — le code doit être prêt pour une
  revue professionnelle sans explication orale.
- **Erreurs** : jamais de `catch` vide ; exceptions métier NestJS typées, messages utilisateurs en
  français via i18n ; tout chemin d'échec est un cas conçu, pas un accident.
- **Tests** : unitaires sur la logique métier (calculs monétaires, dérivation de statuts, conversions
  d'unités), tests de concurrence sur tout mouvement de stock, e2e sur les parcours critiques (§18).
- **Performance** : requêtes N+1 interdites (`include`/`select` délibérés), pagination serveur
  obligatoire sur toute liste, index vérifiés pour toute nouvelle requête filtrée.
- **Structure** : logique partagée dans `packages/` (jamais dupliquée entre web et mobile) ; pas de
  code mort ; pas de `TODO` sans référence de session ; migrations Prisma nommées et relues avant commit.

## Règles UX (détail : docs/ux/standards.md, à lire pour toute session frontend)

- Chaque écran livre ses 5 états : chargement (skeleton), vide (CTA), erreur (actionnable), partiel, succès.
- Destructif = AlertDialog nommant l'objet + verbe explicite ; irréversible = raison obligatoire.
- Montants en chasse fixe tabulaire, XAF ; contraste AA garanti y compris couleur tenant.
- Vocabulaire continu (le bouton « Encaisser » produit « Encaissé ») ; texte en français, sentence case.

## Index documentaire (lecture à la demande, jamais préventive)

- `docs/roadmap/01-architecture.md` — stack, arborescence, schéma Prisma (34+ modèles), modules, temps réel, files, DevOps (§0–§12)
- `docs/roadmap/02-plan-et-decisions.md` — phases P0–P14, pièges, checklist de recette, décisions A→AE (§13–§17)
- `docs/roadmap/03-parcours-metier.md` — parcours fonctionnels de référence (§18)
- `docs/roadmap/04-sessions.md` — plan de travail : sessions + critères « Fait quand » (§19)
- `docs/ux/standards.md` — 10 standards UX + motifs transverses
- `docs/ux/tokens.md` — couleurs, typographie, composants & états obligatoires
- `docs/ux/parcours/INDEX.md` — index des specs UX par domaine (acquisition, caisse, ventes, catalogue, stock, rapports, pilotage, mobile, plateforme)
