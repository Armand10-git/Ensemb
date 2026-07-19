# Roadmap technique — Reproduction d'Ensemb 

**Stack cible :** NestJS · TypeScript · Prisma · PostgreSQL · Redis · BullMQ · Socket.io · React · Vite · TailwindCSS · shadcn/ui · TanStack Router · TanStack Query · Zustand · React Native · Expo · Turborepo · Docker · GitHub Actions

> Ce document remplace la version agnostique précédente. La stack étant désormais figée, chaque phase liste les modules NestJS, modèles Prisma, écrans React, files BullMQ, événements Socket.io et standards DevOps (CI/CD, conteneurisation, observabilité) concrets à livrer. Il sert à la fois de **roadmap de projet** et de **fichier de référence technique** (architecture, schéma de données, conventions) à garder ouvert pendant tout le développement.

> **Révision du 16 juillet 2026 (revue sécurité & exploitation)** — décisions ajoutées en §17 : chiffrement des secrets tenant (S), piège RLS/pooling (T), journal d'audit (U), paiements mobile money asynchrones & idempotence des webhooks (V), MFA plateforme (W), génération des références (X), stockage objet (Y), workers BullMQ dédiés (Z), versionnement d'API (AA), continuité/PITR (AB), annulation de document (AC), jalon MVP (AD), mode hors-ligne POS assumé hors périmètre (AE). Les sessions intercalaires S08b, T07b, S15b, S21b, S23b, S30b et S50b (§19) portent leur implémentation.

---


> **Extrait ciblé — Phases, pièges, checklist, annexes, décisions (§13–§17).** Document découpé pour lecture sélective par Claude Code ; la version intégrale fait référence.

## 13. Roadmap détaillée par phases (P0–P14)

### P0 — Bootstrap du monorepo & socle DevOps
- [x] Init Turborepo (`pnpm dlx create-turbo@latest`), workspaces `apps/*` + `packages/*` — S01 ✅
- [x] `packages/config` : `tsconfig.base.json`, config ESLint/Prettier partagée, `tailwind.config.ts` avec la palette verte par défaut de la plateforme (§3) — S01 ✅
- [x] `packages/database` : init Prisma — S01 ✅
- [x] `docker-compose.yml` racine (Postgres + Redis) pour le développement local (§12.1) — S02 ✅
- [x] `Dockerfile` multi-stage pour `apps/api` et `apps/web` (§12.1) — S02 ✅
- [x] Pipeline CI (`.github/workflows/ci.yml`) : lint + typecheck + test + build sur chaque PR, cache Turborepo distant (§12.2) — S03 ✅ (dette : protection `main` + lint-staged/prettier à finaliser)
- [x] Conventional Commits + `commitlint`/`husky`, branches protégées sur `main` (§12.6) — S03 ✅

### P1 — Socle backend & multi-tenance
- [x] Schéma `Organization` + `PlatformAdmin` (§4), migration initiale — fondation dont dépend tout le reste, y compris `User` — T01 ✅
- [x] `TenancyModule` : middleware de résolution de tenant par sous-domaine, contexte de requête, extension Prisma d'auto-scoping par `organizationId` (§5, §17 point A) — T02 ✅
- [x] Row-Level Security PostgreSQL en défense en profondeur (§4) — T03 ✅
- [x] `AuthModule` : login JWT (access 15 min + refresh 7 j en base), guard `isActive`, scoping par organisation — S06 ✅
- [x] `RolesModule` + `PermissionGuard` + décorateur `@RequirePermission()` — S07 ✅
- [x] Préfixe global d'API `/api/v1` (§17, point AA) + `AuditModule` (modèle `AuditLog` + interceptor global, §17 point U) — S08b ✅
- [x] `RealtimeModule` (Gateway Socket.io minimal, rooms scopées par organisation) — S08 ✅
- [ ] `QueueModule` (connexion Redis/BullMQ, workers dédiés — §17 point Z) — à venir (S16+)
- [x] Interceptor `records.viewAll` générique — S07 ✅
- [x] Flow d'inscription (§18) : création `Organization` + premier utilisateur admin + validation de disponibilité du sous-domaine — T04 ✅

### P2 — Modèle de données
- [x] Schéma Prisma `User`, `Role`, `Permission`, `RoleOnUser`, `PermissionOnRole`, `AuditLog` (§4) + migrations — S04 ✅ (schéma complet métier à compléter en Bloc C+)
- [ ] Index composites `(organizationId, …)` et index uniques partiels (`WHERE deleted_at IS NULL`) posés dans la migration initiale (§4) ; table `DocumentCounter` pour la génération transactionnelle des références de documents (§17, point X) — S15b
- [x] Seed : catalogue des permissions (108 droits), rôle Administrateur complet, utilisateur admin — S05 ✅ (client "walk-in", devise et entrepôt par défaut : S09+)

### P3 — Référentiels
- [ ] `CatalogModule` (catégories, marques, unités + conversion, devises) + écrans web correspondants
- [ ] `PartnersModule` (clients, fournisseurs) + import CSV / export Excel (via `excel-queue`)

### P4 — Produits & stock
- [ ] `UploadsModule` : upload/redimensionnement d'images (`multer` + `sharp`), branché sur produits/marques/logo/avatar (§17, point E) — stockage objet S3-compatible dès cette phase, jamais le disque local (§17, point Y)
- [ ] CRUD produit + variantes + code-barres, avec choix du format de papier pour l'impression d'étiquettes
- [ ] `InventoryModule` : stock par entrepôt, ajustements, transferts, événement `stock:updated`
- [ ] Champ `ProductWarehouse.version` posé dès la migration initiale (§17, point B), même si le verrouillage n'est exploité qu'en P5
- [ ] Alerte de stock bas → événement `stock:lowAlert` **et** persistance dans `Notification` (§17, point I)
- [ ] Décision explicite : le stock peut-il devenir négatif (back-order) ou la vente est-elle bloquée à zéro ? (§17, point G)

### P5 — Ventes & POS
- [ ] `SalesModule` (CRUD, statut de paiement auto-calculé)
- [ ] `PosModule` : recherche/scan (douchette USB sur web, caméra sur mobile), calcul serveur du total, transaction Prisma `Serializable` avec relecture de `ProductWarehouse.version` pour empêcher la survente multi-caisse (§17, point B)
- [ ] Flux de paiement mobile money **asynchrone** au comptoir : vente `AWAITING_PAYMENT` (stock réservé), délai d'expiration configurable, restitution du stock à l'expiration ou l'annulation (§17, point V ; §18.2 étape 10)
- [ ] Annulation d'une vente validée : permission dédiée `sales.cancel`, restitution du stock sous verrouillage, trace `AuditLog` (§18.18)
- [ ] Écran web `pos.tsx` + écran mobile équivalent (mode en ligne d'abord)
- [ ] Reçu imprimable : `react-to-print`/`expo-print` en repli, impression ESC/POS thermique réelle en cible (§17, point D)
- [ ] Entrepôt/caisse par défaut : décider s'il reste un réglage global (`Setting.defaultWarehouseId`) ou devient sélectionnable par terminal/session de caisse (§17, point J)

### P6 — Achats & retours
- [ ] `PurchasesModule` (réception = incrément stock)
- [ ] `ReturnsModule` (retours vente/achat, ajustement de stock inverse)

### P7 — Devis, transferts, ajustements, dépenses
- [ ] `QuotationsModule` + conversion en vente
- [ ] `ExpensesModule` + catégories de dépenses
- [ ] **Premier dry-run du script de migration MySQL → PostgreSQL** sur un extrait de données réelles — le schéma des tables documentaires étant désormais stable, S50 (P14) devient l'exécution finale d'un script déjà éprouvé, pas une découverte tardive d'incompatibilités

### P8 — Paiements, facturation SaaS & intégrations externes
- [ ] `PaymentsModule` : espèces (calcul monnaie rendue) + agrégateur de paiement (carte/mobile money, mapping client↔compte, confirmation par webhook), identifiants API propres à chaque organisation — webhooks **idempotents** via `WebhookEvent` (§17, point V), secrets tenant chiffrés en base avant écriture (§17, point S)
- [x] `BillingModule` — T06 : `Plan`, `Subscription`, `PlatformSetting`, seed des 3 plans XAF, `computeTrialPeriod()`, `QuotaGuard` + `@CheckQuota()` sur les endpoints de création (403 explicite, jamais 500)
- [x] `BillingModule` — T07 : `Invoice`, `WebhookEvent`, `PaymentAggregatorService`, `billing-queue` (BullMQ), `WorkerModule` + `src/worker.ts` (entrypoint dédié — §17 point Z), lien de paiement à la souscription, webhook HMAC idempotent + `receivedAt`/`processedAt`/`organizationId` sur `WebhookEvent`, vérification plafond CA d'essai
- [x] Intégration de l'agrégateur de paiement pour la facturation récurrente de la plateforme : lien de paiement généré à chaque échéance (`billing-queue`), webhook dédié qui confirme et prolonge l'abonnement
- [ ] `NotificationsModule` : consumers `email-queue`/`sms-queue` (Nodemailer + Twilio SDK)
- [ ] `pdf-queue` : templates HTML → PDF (Puppeteer, brandés par organisation) pour factures/devis/retours/paiements
- [ ] SMTP dynamique stocké en base (table `SmtpServer`, une par organisation), jamais dans un fichier `.env`

### P9 — Rapports & dashboard
- [ ] `ReportsModule` : tous les rapports identifiés (clients, fournisseurs, top produits, profit & perte, par entrepôt)
- [ ] Cache Redis sur les agrégats lourds, invalidation sur événements métier
- [ ] Dashboard web avec graphiques (Recharts ou Visx) + abonnement `dashboard:refresh`

### P10 — Utilisateurs & permissions avancées
- [ ] Écran de gestion des rôles/permissions (assignation des 89 droits)
- [ ] Vérification bout en bout de la règle `records.viewAll` sur tous les modules documentaires

### P11 — Réglages système, personnalisation, sauvegarde
- [ ] `SettingsModule` complet (société, langue/devise par défaut, options du reçu POS) — un jeu de réglages par organisation
- [ ] `OrganizationsModule` : écran de personnalisation (logo, couleur primaire avec contrôle de contraste, aperçu en direct — §3, §18)
- [ ] `PlatformAdminModule` : écran séparé de gestion des organisations (liste, statut d'abonnement, suspension/réactivation), inaccessible depuis un sous-domaine tenant
- [ ] `BackupModule` : export de données par organisation à la demande (CSV/JSON), listing/téléchargement/suppression, purge auto ; le `pg_dump` complet devient une tâche d'exploitation plateforme, pas une fonctionnalité tenant

### P12 — Application mobile
- [ ] Init Expo app, `expo-router`, design system partagé (`nativewind`), écran de résolution de tenant (identifiant d'organisation avant login, §10)
- [ ] Écran POS mobile connecté à l'API (mêmes hooks TanStack Query que web via `packages/types`) (§10)
- [ ] Abonnement Socket.io (`stock:updated`, `sale:created`) pour le temps réel (§10)
- [ ] Pipeline `eas build`/`eas submit` intégré au CI/CD (§12.3)

### P13 — Frontend web complet & polish
- [ ] Tous les écrans restants (§9), i18n `fr`/`en` puis extension
- [ ] Résolution du tenant et thème dynamique par organisation avant le rendu de l'écran de login (§9)
- [ ] Thème clair/sombre par-dessus la couleur de marque (vert par défaut ou couleur choisie par l'organisation), audit d'accessibilité (contrastes, focus visible)

### P14 — Recette, migration de données, mise en production
- [ ] Script de migration des données existantes vers la nouvelle base, table par table selon §4, rattachées à une `Organization` créée pour l'occasion
- [ ] Vérification que les permissions et leurs assignations par rôle ont migré correctement (`Permission.name` comme clé de correspondance)
- [ ] Vérification qu'une requête sur le sous-domaine d'une organisation ne retourne jamais les données d'une autre (test d'isolation multi-tenant)
- [ ] DNS wildcard et certificat SSL wildcard opérationnels en production (§12.7)
- [ ] Exécution intégrale de la checklist §15
- [ ] Pipelines de déploiement `staging`/`prod` validés, rollback testé (§12.3)
- [ ] Dashboards de monitoring et alerting en place avant bascule (§12.5)
- [ ] Test de restauration PITR complet exécuté et vérifié sur un environnement jetable, RPO/RTO validés (§12.8, §17 point AB)

---

## 14. Pièges connus & recommandations

> **Isolation multi-tenant, la règle la plus critique du document.** Un seul repository/service qui oublie de filtrer par `organizationId` expose les données d'un tenant à un autre. Ne jamais s'appuyer uniquement sur la discipline des développeurs : l'extension Prisma d'auto-scoping (§4, §5) doit rendre l'oubli **impossible**, pas seulement improbable, et la Row-Level Security PostgreSQL est le filet de sécurité si un accès direct à la base contourne un jour Prisma (script, requête ad hoc, futur service).

> **RLS et pooling de connexions — le piège qui annule la défense en profondeur (§17, point T).** Avec un pool de connexions (pool Prisma, PgBouncer), la variable `app.current_tenant` doit être posée en **`SET LOCAL` dans la même transaction** que les requêtes qu'elle protège — un `SET` de session classique survivrait à la restitution de la connexion au pool et fuiterait le tenant précédent vers la requête suivante. Le test d'isolation de T03 doit explicitement simuler la réutilisation de connexion.

> **Rejeu de webhook (§17, point V).** La signature prouve l'origine d'un webhook, pas son unicité : un même événement livré deux fois (retry de l'agrégateur, incident réseau) prolongerait deux fois un abonnement ou validerait deux fois un paiement POS. Chaque webhook est persisté dans `WebhookEvent` avec contrainte d'unicité sur `(provider, providerEventId)` **avant** tout traitement — un doublon est acquitté puis ignoré.

> **POS « toujours connecté » : arbitrage assumé (§17, point AE).** Le contexte d'exploitation visé connaît des coupures réseau et électriques fréquentes ; sans mode dégradé, une boutique ne peut plus encaisser pendant une coupure. Cette itération assume ce choix — le coût d'un vrai offline-first (base locale, synchronisation, résolution de conflits) est hors de proportion ici. Piste d'évolution identifiée si le terrain le réclame : file locale de ventes en attente, sans base locale complète.

> **Confusion entre les deux comptes de l'agrégateur de paiement.** Le compte de facturation de la plateforme (prélève les tenants) et le compte de paiement propre à chaque tenant (encaisse ses propres clients) ne doivent jamais partager les mêmes clés API ni le même endpoint de webhook — une confusion ferait apparaître un abonnement SaaS payé comme une vente POS, ou l'inverse.

> **Configuration sensible.** Ne jamais réécrire un fichier `.env` à chaud pour changer les clés de l'agrégateur de paiement/Twilio depuis l'UI. Toute configuration sensible (clés API, SMTP) est stockée **en base**, par organisation (`SmtpServer`, table `settings` étendue) et lue à l'exécution.

> **Session de caisse.** Non prévue par défaut : le POS enregistre directement des ventes `isPos=true`, sans ouverture/fermeture ni fond de caisse. **Recommandation ferme : l'inclure** — fond de caisse, ouverture/clôture et écart de caisse sont le premier reproche des gérants en usage multi-caissier réel. Décision à acter avant la Phase P5 ; si elle est retenue, la session S23b (Bloc E, §19) en porte l'implémentation.

> **Discipline d'architecture.** Respecter strictement le découpage `Module → Controller → Service → Repository (Prisma)` dès la Phase P1, sans concentrer la logique métier dans les contrôleurs.

> **Cohérence du seed.** Décider explicitement des données de démonstration (localisation, devise par défaut) avant la Phase P2. Le champ `Currency.symbolPosition` (§4) gère la position du symbole monétaire.

> **Fuseau horaire.** Une app pleine de rapports datés (`report_today`, filtres par période) doit stocker toutes les dates en UTC (`DateTime` Prisma) et les afficher dans le fuseau de l'entrepôt ou de l'utilisateur (`Setting.timezone`, §4) — sans quoi le "rapport du jour" peut se décaler d'une journée selon où se trouve l'utilisateur, en particulier avec le canal mobile qui peut être utilisé en déplacement.

> **Stock négatif.** Décider explicitement si une vente peut faire passer `ProductWarehouse.quantity` sous zéro (back-order) ou si elle doit être bloquée à zéro — cette règle conditionne la validation dans `PosModule`/`SalesModule` (§5) et doit être actée avant la Phase P5.

> **Sous-domaines réservés.** À l'inscription (§18), valider le sous-domaine choisi contre une liste noire (`www`, `api`, `admin`, `app`, `mail`, `blog`…) — sans quoi un tenant pourrait revendiquer un sous-domaine qui entre en conflit avec une route technique de la plateforme.

> **Seuil de plafond d'essai jamais codé en dur.** `Plan.trialRevenueCapAmount` et `PlatformSetting.launchPromoEndsAt` (§17 point R) sont des valeurs modifiables par le staff plateforme (`PlatformAdminModule`), jamais des constantes dans le code — le montant exact et la date de fin de la fenêtre de lancement sont des décisions commerciales, pas des paramètres techniques figés au déploiement. ✅ T06 : `RegistrationService` lit `PlatformSetting.launchPromoEndsAt` depuis la base dans chaque transaction d'inscription (jamais de valeur par défaut en dur) ; `getPlatformSetting()` valide le type JSON avant usage.

> **Vérification du plafond de CA non bloquante.** Le calcul du chiffre d'affaires cumulé d'une organisation en essai (somme de ses `Sale.grandTotal`) ne doit jamais ralentir la validation d'une vente au comptoir : la vérification se fait après la transaction de vente (event asynchrone ou job léger dans `billing-queue`), jamais dans la même transaction Prisma que `PosModule` (§5, §17 point B) — sans quoi chaque vente d'un compte en essai deviendrait plus lente à mesure que son historique grossit.

> **Alertes de stock bas volatiles.** Une alerte émise alors qu'aucun client n'est connecté serait perdue avec Socket.io seul. Le modèle `Notification` (§4) la persiste pour qu'un utilisateur la retrouve à sa prochaine connexion.

---

## 15. Checklist de recette finale

- [ ] Un rôle avec toutes les permissions accède à tous les écrans (web + mobile)
- [ ] Un rôle sans `records.viewAll` ne voit que ses propres documents
- [ ] Une vente POS (web ou mobile) décrémente le bon entrepôt, avec conversion d'unité si applicable, et diffuse `stock:updated` en temps réel aux autres postes connectés
- [ ] Un achat réceptionné incrémente le stock ; un retour l'ajuste dans le bon sens
- [ ] Un transfert entre entrepôts est atomique (source décrémentée / destination incrémentée ensemble ou aucune des deux)
- [ ] Le statut de paiement se recalcule après chaque paiement enregistré
- [ ] Un devis converti en vente reproduit fidèlement lignes, taxes, remises
- [ ] Emails, SMS, PDF et exports Excel partent bien via BullMQ (vérifier les retries en cas d'échec du fournisseur externe)
- [ ] Un paiement carte ou mobile money (Orange Money/MTN MoMo) aboutit et le mapping local est enregistré
- [ ] Les rapports renvoient des montants cohérents avec les documents sources, y compris après invalidation du cache Redis
- [ ] La sauvegarde se génère, se liste, se télécharge et se supprime (purge automatique vérifiée)
- [ ] Un compte désactivé est déconnecté immédiatement (token blacklisté dans Redis) et ne peut plus se reconnecter
- [ ] Thème clair/sombre cohérent sur web ET mobile, avec la couleur de l'organisation (ou le vert par défaut si non personnalisé)
- [ ] Deux caisses qui vendent simultanément le dernier exemplaire d'un produit ne peuvent pas toutes les deux réussir (test de charge concurrent sur `PosModule`, §17 point B)
- [ ] Le scan fonctionne à la douchette USB sur le web et à la caméra sur mobile ; un reçu s'imprime sur une imprimante thermique réelle en plus du PDF de repli
- [ ] Le "rapport du jour" reste correct pour un utilisateur dans un fuseau horaire différent de celui de l'entrepôt
- [ ] Le client OpenAPI généré (web/mobile) est à jour avec l'API — la CI échoue si un DTO change sans régénération (§17 point C)
- [ ] La migration de données réelle (pas seulement le seed) préserve les relations via la table de correspondance d'IDs (§17 point A)
- [ ] Deux organisations différentes ne voient jamais mutuellement leurs données, y compris en devinant un ID dans l'URL (test d'isolation multi-tenant, requêtes API et SQL brutes)
- [ ] Le sous-domaine et la couleur d'une organisation s'affichent correctement sur l'écran de login, avant toute authentification, sur web et mobile
- [x] Un dépassement de quota (utilisateurs, entrepôts, produits) selon le plan renvoie une erreur explicite, jamais une erreur 500 — `QuotaGuard` + `@CheckQuota()` (T06)
- [ ] Le staff plateforme peut suspendre une organisation ; ses utilisateurs sont alors bloqués à la connexion, immédiatement
- [ ] Un compte tenant normal ne peut jamais atteindre les endpoints/écrans réservés au staff plateforme, même en devinant l'URL
- [ ] Une facture d'abonnement se génère à échéance, le paiement par carte ou mobile money la clôture via webhook, et l'abonnement se prolonge en conséquence
- [x] Une inscription pendant la fenêtre de lancement n'a aucun plafond de CA (`trialEndsAt = launchPromoEndsAt`) — T06
- [x] Une inscription après la fenêtre est coupée dès que son CA cumulé dépasse `Plan.trialRevenueCapAmount`, sans attendre la fin du mois d'essai — T07 (`billing-queue`) ✅
- [x] `PlatformSetting.launchPromoEndsAt` et `Plan.trialRevenueCapAmount` modifiables en base sans redéploiement — T06
- [ ] Écran d'administration plateforme pour modifier ces valeurs sans passer par SQL — T08 (`PlatformAdminModule`)
- [ ] Le pipeline CI (lint/typecheck/test/build) est vert sur `main`, avec cache Turborepo distant actif
- [ ] Les images Docker `api`/`web` démarrent en local via `docker-compose up` sans configuration manuelle
- [ ] Les probes `/health` et `/ready` répondent correctement (DB et Redis coupées → `/ready` échoue proprement)
- [ ] Logs structurés, métriques et alerting sont visibles dans les dashboards avant la bascule en production
- [x] Les secrets tenant en base (`SmtpServer.password`, clés agrégateur) sont illisibles dans un dump SQL brut (chiffrement applicatif vérifié, §17 point S) ✅ T07b
- [ ] Toute mutation sensible (suppression/annulation de document, changement de permissions, suspension d'organisation) laisse une trace exploitable dans `AuditLog` (acteur, avant/après)
- [ ] La connexion `PlatformAdmin` exige un second facteur TOTP — refusée sans lui (§17 point W)
- [ ] Le test d'isolation multi-tenant couvre la réutilisation de connexion du pool (`SET LOCAL`, §14 / §17 point T)
- [x] Un webhook de paiement rejoué à l'identique est acquitté sans aucun effet métier (idempotence `WebhookEvent` — contrainte `(provider, providerEventId)`, `receivedAt` horodatage réception, `processedAt` nullable fin de traitement, `organizationId` scope tenant) ✅ T07
- [ ] Deux créations simultanées de documents dans la même organisation ne produisent jamais de collision de `reference` (test de concurrence sur `DocumentCounter`, §17 point X)
- [ ] Un paiement mobile money non confirmé expire proprement : la vente `AWAITING_PAYMENT` est annulée et le stock restitué (§18.2 étape 10)
- [ ] L'annulation d'une vente validée restitue le stock et journalise l'acteur et la raison (§18.18)
- [ ] Une restauration PITR complète a été exécutée et vérifiée sur un environnement jetable avant la bascule (§12.8)

---

## 16. Annexes

### Langues à couvrir à terme
`fr`, `en`, `es`, `ar`, `de`, `it`, `ru`, `tr`, `th`, `vi`, `id`, `zh-CN`, `hi`.

### Glossaire
| Terme | Sens |
|---|---|
| `reference` | Numéro de document (facture, devis…) |
| `paymentStatus` | `PAID` / `PARTIAL` / `UNPAID`, recalculé automatiquement |
| `grandTotal` | Montant total TTC du document |
| `isPos` | Distingue une vente caisse d'une facture classique |
| `records.viewAll` | Permission spéciale : voir tous les documents, pas seulement les siens |
| `symbolPosition` | Position du symbole monétaire (`BEFORE`/`AFTER` le montant) |
| `version` (ProductWarehouse) | Compteur de verrouillage optimiste, incrémenté à chaque mouvement de stock pour empêcher la survente |
| `organizationId` | Identifiant du tenant, présent sur toute table métier ; racine de l'isolation multi-tenant (§4, §17) |
| `subdomain` | Sous-domaine unique d'une organisation (`{subdomain}.monapp.com`), résolu avant l'authentification |
| `Plan` / `Subscription` / `Invoice` | Offre tarifaire, abonnement d'une organisation à un plan, et son historique de facturation (§4) |
| Quota | Limite d'usage définie par le plan (ex. `maxUsers`), vérifiée par `QuotaGuard` à la création |
| `PlatformAdmin` | Compte du staff de la plateforme, complètement distinct des utilisateurs d'une organisation |

### Stratégie de tests & données de test

L'original s'appuyait sur `Faker` + une factory (`UserFactory`) pour ses tests PHPUnit. Équivalent à prévoir dès la Phase P1, pas en fin de projet — avec **trois niveaux distincts**, chacun avec son rôle et son outillage propre :

| Niveau | Ce qu'il couvre | Outillage | Dépendances externes |
|---|---|---|---|
| **Unitaire** | La logique pure d'un service NestJS : calcul de taxe/remise, conversion d'unité, calcul de `paymentStatus`, règles de permission | Jest, tout mocké (`PrismaClient`, Redis, agrégateur de paiement, BullMQ) | Aucune — s'exécute en quelques secondes, aucune base de données |
| **Intégration** | Un module NestJS de bout en bout : controller → service → **vraie base Postgres de test** → réponse HTTP réelle | Jest + Supertest, `@nestjs/testing` pour monter un vrai `TestingModule`/app Nest | Postgres + Redis de test (voir infra ci-dessous), pas de mock sur la couche données |
| **E2E** | Un parcours utilisateur complet piloté par l'interface (§18) | Playwright (web), scénarios manuels documentés pour mobile en attendant l'outillage Detox/Maestro | Environnement complet (`docker-compose up`) |

- **Factories** : `@faker-js/faker` + une factory Prisma par modèle clé (`userFactory`, `productFactory`, `saleFactory`) dans `packages/database/test-factories/`, réutilisées par les tests d'intégration `api` et les seeds de démo.
- **Infrastructure des tests d'intégration** : `docker-compose.test.yml` dédié (Postgres + Redis sur des ports distincts de ceux du dev), base recréée par migration Prisma avant chaque run (`prisma migrate reset --force` en `beforeAll`), chaque fichier de test tournant dans une transaction annulée en fin de test (ou schéma dédié par worker Jest si les tests tournent en parallèle) pour rester isolé et rejouable.
- **Contrat** : les DTOs `nestjs-zod` de `packages/types` sont testés une fois (tests unitaires), partagés par tous les consommateurs.
- **Seuil de couverture** : ≥ 80 % sur `apps/api/src/**/*.service.ts` (logique métier), vérifié en CI (`jest --coverage`) — indicatif, à ajuster avec l'équipe, mais un seuil doit exister pour éviter la dérive.
- **E2E critiques** (Playwright côté web) : au minimum — une vente POS avec taxe + remise + conversion d'unité, un paiement partiel puis complémentaire, un ajustement de stock, une vente concurrente sur le dernier exemplaire d'un produit (test de non-survente, §17 point B).

### Manifeste de paquets (extrait des dépendances clés)

**`apps/api`** : `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/jwt`, `@nestjs/passport` + `passport-jwt`, `@nestjs/bullmq` + `bullmq`, `@nestjs/websockets` + `@nestjs/platform-socket.io` + `@socket.io/redis-adapter`, `@nestjs/throttler`, `@nestjs/swagger`, `@nestjs/terminus` (health checks), `@prisma/client` + `prisma`, `ioredis`, `nestjs-zod` + `zod`, `multer` + `sharp`, `puppeteer`, `exceljs`, `nodemailer`, `twilio`, SDK/client HTTP de l'agrégateur de paiement (ex. `cinetpay-nodejs`), `pino` + `nestjs-pino`, `@willsoto/nestjs-prometheus`.

**`apps/web`** : `react`, `react-dom`, `vite`, `tailwindcss`, `@tanstack/react-router`, `@tanstack/react-query`, `zustand`, `class-variance-authority`, `tailwind-merge`, `lucide-react`, `react-i18next`, `jsbarcode`, `react-to-print`, `recharts`, `sonner`.

**`apps/mobile`** : `expo`, `react-native`, `expo-router`, `expo-camera`, `expo-print`, `nativewind`, `@tanstack/react-query`, `zustand`, `socket.io-client`.

### Variables d'environnement à prévoir (`apps/api/.env`)
```
DATABASE_URL=postgresql://user:pass@localhost:5432/ensemb
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
APP_ENCRYPTION_KEY=                                # clé maîtresse AES-256-GCM des secrets tenant en base (§17 point S) — rotation documentée, jamais en base ni dans le dépôt
APP_ROOT_DOMAIN=monapp.com                        # pour résoudre {subdomain}.monapp.com
PAYMENT_AGGREGATOR_API_KEY=                        # compte PLATEFORME (facturation SaaS) — distinct des clés par tenant en base
PAYMENT_AGGREGATOR_SITE_ID=
PAYMENT_AGGREGATOR_WEBHOOK_SECRET=
TWILIO_SID=
TWILIO_TOKEN=
TWILIO_FROM=
NODE_ENV=production
SENTRY_DSN=
```

> Les identifiants de l'agrégateur **par tenant** (utilisés par `PaymentsModule`/`PosModule` pour l'encaissement POS) ne vont jamais dans `.env` : ils sont saisis par chaque organisation dans `SettingsModule` et stockés en base, comme le reste de la configuration sensible par organisation.

### Secrets CI/CD à provisionner (GitHub Actions)
`DOCKER_REGISTRY_TOKEN`, `STAGING_DEPLOY_KEY`, `PROD_DEPLOY_KEY`, `TURBO_TOKEN` + `TURBO_TEAM` (cache distant), `EAS_TOKEN` (build mobile), `SENTRY_AUTH_TOKEN` (upload des source maps).

---

## 17. Conventions & décisions d'architecture

Décisions transverses qui s'appliquent à plusieurs sections du document, regroupées ici pour ne pas les chercher dans le fil du texte.

| # | Sujet | Décision | Où c'est appliqué |
|---|---|---|---|
| A | Identifiants | Tous les IDs (PK/FK) en UUID (`String @default(uuid()) @db.Uuid`) ; seed des permissions par `name` | §4, T01 |
| B | Concurrence multi-caisse | Verrouillage optimiste : colonne `ProductWarehouse.version` + transaction Prisma `Serializable` dans `PosModule` | §4, §5, P4, P5, checklist §15 |
| C | Validation & contrat d'API | `nestjs-zod` comme source unique (DTO = schéma zod), `@nestjs/swagger` génère l'OpenAPI, client typé régénéré en CI pour web/mobile | §2, §5, checklist §15 |
| D | Périphériques POS | Listener clavier "keyboard wedge" sur web, `expo-camera` sur mobile, librairie ESC/POS dédiée pour l'impression thermique (repli `react-to-print`/`expo-print`) | §9, §10, P5, checklist §15 |
| E | Upload de fichiers | `UploadsModule` dédié (`multer` + `sharp`) | §5, P4 |
| F | Fuseaux horaires | Dates stockées en UTC, `Setting.timezone` (défaut `Africa/Douala`), affichage localisé côté client | §4, §14, checklist §15 |
| G | Stock négatif | À confirmer explicitement avant P5 (par défaut : bloqué à zéro) | §14, P4 |
| H | Installation & mise à jour | Pas d'assistant web dédié : seed + pipeline CI/CD (§12) ; à reconsidérer si une distribution en marque blanche est envisagée | §12, §14 |
| I | Notifications | Modèle `Notification` persistant, consultable à la reconnexion | §4, §14 |
| J | Entrepôt par défaut | À trancher en P5 : `Setting.defaultWarehouseId` global ou sélection par session de caisse | P5 |
| K | Tests | Taxonomie unitaire/intégration/e2e + infra Postgres de test + DoD générique appliquée à toute session | §12.2, §16, §19 |
| L | Outillage | Manifeste de dépendances + stratégie de factories/tests | §16 |
| M | Multi-tenance | Isolation par `organizationId` (Prisma auto-scoping + Row-Level Security), résolution par sous-domaine ; `Permission` reste un catalogue global, `Role` devient par organisation ; deux comptes distincts chez l'agrégateur de paiement (plateforme vs chaque tenant) | §4, §5, §9, §11, §14, T01–T03 |
| N | Sauvegarde en environnement partagé | Le `pg_dump` complet n'est plus une fonctionnalité tenant : chaque organisation exporte ses propres données (CSV/JSON), le `pg_dump` complet devient une tâche d'exploitation plateforme | §5, §12, T09 |
| O | Domaine personnalisé | Hors périmètre de cette itération ; champ `Organization.customDomain` prévu au schéma dès maintenant pour ne pas bloquer son ajout plus tard | §4, §12.7 |
| P | Topologie de domaines | `monapp.com`/`www` → `apps/marketing` (vitrine, hors tenant) ; `{subdomain}.monapp.com` → `apps/web` résolu par tenant ; `admin.monapp.com` → `apps/web` route group `platform-admin/`, auth `PlatformAdmin` séparée | §9, §12.7 |
| Q | Tableau de bord plateforme | Indicateurs business (MRR, conversion essai→payant, churn, factures en échec) agrégés tous tenants confondus, mis en cache et recalculés périodiquement — jamais calculés à la volée sur l'ensemble des `Subscription`/`Invoice` à chaque chargement | §5, §18.16, T08 |
| R | Politique d'essai | Fenêtre de lancement de 2 mois calendaires (`PlatformSetting.launchPromoEndsAt`) : accès gratuit sans plafond de CA pour tout inscrit durant cette fenêtre. Après la fenêtre : essai standard de `Plan.trialDurationDays` (30 jours par défaut), coupé plus tôt si le CA cumulé de l'organisation dépasse `Plan.trialRevenueCapAmount` — seuil configurable par le staff plateforme, sans valeur imposée par défaut. ✅ T06 — `computeTrialPeriod(now, launchPromoEndsAt, trialDurationDays)` dans `RegistrationService`, `Subscription TRIALING` atomique, seed `launchPromoEndsAt = "2026-09-30T23:59:59Z"`. ✅ T07 — `BillingService.checkTrialCap()` retourne `boolean` (true = plafond atteint), appelé via `billing-queue` `billing.checkTrialCap` (job 24h repeat) : `invoice.aggregate` CA cumulé >= `trialRevenueCapAmount` → Subscription PAST_DUE + `trialEndedReason = REVENUE_CAP` + Socket.io `organization:trialCapReached` ; `BillingWorker.handleCheckTrialCap()` consomme le booléen directement (un seul appel DB, pas de double `getSubscription`). Reste : écran d'administration (T08). | §4, §5, §18.0, §18.15, T06, T07, T08 |
| S | Secrets tenant en base | Chiffrement applicatif AES-256-GCM avant écriture (`SmtpServer.password`, clés agrégateur par tenant) ; clé maîtresse `APP_ENCRYPTION_KEY` en variable d'environnement/KMS, rotation documentée | §4, §12.4, P8, T07b, checklist §15 |
| T | RLS & pooling de connexions | `app.current_tenant` posé via `SET LOCAL` dans la transaction, jamais en `SET` de session — sinon fuite de tenant à la réutilisation de connexion ; test d'isolation simulant la réutilisation | §14, T02/T03, checklist §15 |
| U | Journal d'audit | Modèle `AuditLog` + interceptor global (`AuditModule`) sur toute mutation sensible, tenant et plateforme confondus (acteur, entité, avant/après) | §4, §5, P1, S08b, checklist §15 |
| V | Paiements asynchrones & idempotence | Mobile money = flux asynchrone : vente `AWAITING_PAYMENT` (stock réservé) → confirmation webhook ou expiration avec restitution du stock ; idempotence par `WebhookEvent` unique sur `(provider, providerEventId)` — champs : `receivedAt` (horodatage de réception, `@default(now())`), `processedAt DateTime?` (fin de traitement, null si ignoré/erreur), `organizationId String?` (scope tenant résolu via `invoiceId` ✅ T07) | §4, §5, §18.2, P5/P8, T07, T07b, checklist §15 |
| W | MFA staff plateforme | TOTP obligatoire pour tout `PlatformAdmin` — un compte compromis donnerait accès à l'ensemble des tenants | §4, T08, checklist §15 |
| X | Génération des références | Table `DocumentCounter` par `(organizationId, documentType)`, incrémentée dans la transaction de création — jamais de « max + 1 » applicatif, source de collisions en concurrence | §4, P2, S15b, checklist §15 |
| Y | Stockage de fichiers | Objet S3-compatible tranché (préfixe par organisation, URLs signées) — le stockage local est éliminatoire en multi-instance conteneurisée | §5, P4 |
| Z | Topologie BullMQ | Processors dans un process worker dédié (même image Docker, entrypoint distinct), déployé et scalé indépendamment de l'API — Puppeteer ne cohabite pas avec la latence du POS. ✅ T07 (billing) — `WorkerModule` (`src/workers/worker.module.ts`) + `src/worker.ts` ; `BillingWorker` retiré de `BillingModule` (HTTP ne consomme aucun job) | §7, §12.1 |
| AA | Versionnement d'API | Préfixe global `/api/v1` dès P1 — protège les versions mobiles déjà installées contre tout changement de contrat | §5, P1, S08b |
| AB | Continuité plateforme | PITR (WAL + snapshots), RPO ≤ 15 min / RTO ≤ 4 h, rétention 30 j + snapshot mensuel 12 mois, test de restauration avant mise en production puis trimestriel | §12.8, P14, S50b, checklist §15 |
| AC | Annulation de document | Parcours dédié (§18.18) : permission propre (`sales.cancel`/`purchases.cancel`), restitution du stock sous verrouillage, trace `AuditLog` — distinct du retour (§18.6) | §11, §18.18, P5, S21b, checklist §15 |
| AD | Jalon MVP | Fin **Bloc E + T01–T07** = première cible commercialisable (inscription, vente POS, abonnement payé) — point de recette intermédiaire ; en cas de glissement, tout ce qui suit ce jalon est négociable, rien de ce qui le précède ne l'est | §19 |
| AE | Mode hors-ligne POS | Hors périmètre assumé : le POS exige la connexion (§10) — conséquence actée : pas d'encaissement pendant une coupure. Piste d'évolution : file locale de ventes en attente, sans base locale complète | §10, §14 |

Les points **A**, **B**, **C**, **M**, ainsi que **S**, **T**, **U** et **V** (sécurité et paiements), sont structurants : à valider avant la fin des Blocs B/B2 (§19), un changement ultérieur (type d'ID, verrouillage, stratégie de validation, isolation multi-tenant) coûte nettement plus cher une fois plusieurs modules écrits.

---
