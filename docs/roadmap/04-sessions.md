# Roadmap technique — Reproduction d'Ensemb 

**Stack cible :** NestJS · TypeScript · Prisma · PostgreSQL · Redis · BullMQ · Socket.io · React · Vite · TailwindCSS · shadcn/ui · TanStack Router · TanStack Query · Zustand · React Native · Expo · Turborepo · Docker · GitHub Actions

> Ce document remplace la version agnostique précédente. La stack étant désormais figée, chaque phase liste les modules NestJS, modèles Prisma, écrans React, files BullMQ, événements Socket.io et standards DevOps (CI/CD, conteneurisation, observabilité) concrets à livrer. Il sert à la fois de **roadmap de projet** et de **fichier de référence technique** (architecture, schéma de données, conventions) à garder ouvert pendant tout le développement.

> **Révision du 16 juillet 2026 (revue sécurité & exploitation)** — décisions ajoutées en §17 : chiffrement des secrets tenant (S), piège RLS/pooling (T), journal d'audit (U), paiements mobile money asynchrones & idempotence des webhooks (V), MFA plateforme (W), génération des références (X), stockage objet (Y), workers BullMQ dédiés (Z), versionnement d'API (AA), continuité/PITR (AB), annulation de document (AC), jalon MVP (AD), mode hors-ligne POS assumé hors périmètre (AE). Les sessions intercalaires S08b, T07b, S15b, S21b, S23b, S30b et S50b (§19) portent leur implémentation.

---


> **Extrait ciblé — Sessions de travail S01–S52b / T01–T10 (§19).** Document découpé pour lecture sélective par Claude Code ; la version intégrale fait référence.

## 19. Découpage en sessions de travail

Les phases P0–P14 (§13) donnent le grain macro ; cette section les subdivise en **52 sessions courtes** (S01–S52, complétées de 6 sessions intercalaires S08b/S15b/S21b/S23b/S30b/S50b issues de la revue sécurité & exploitation) **+ 11 sessions dédiées au multi-tenant/SaaS** (T01–T10 et T07b, Bloc B2), séquencées strictement selon le graphe de dépendances du schéma Prisma (§4) — une table n'est jamais construite avant les tables qu'elle référence par clé étrangère, et `Organization` (T01) précède tout le reste puisque chaque table métier en dépend désormais. Chaque session correspond à peu près à **un module ou une sous-fonctionnalité**, se termine par une définition de "fait" vérifiable, et se clôt idéalement par un commit. Sauf mention contraire, une session dépend de la précédente au sein de son bloc ; les dépendances *entre blocs* sont indiquées en tête de bloc.

> **Définition de "fait" générique, valable pour toute session (en plus de la colonne "Fait quand…" spécifique à chaque ligne) :**
> - **Sessions backend** (Blocs B, B2 à K) : le module livré a (1) des **tests unitaires** Jest sur la logique de service (mocks uniquement — calculs, règles de permission, conversion d'unité…) et (2) au moins un **test d'intégration** Supertest qui monte le module NestJS réel contre la Postgres/Redis de test (§16) et vérifie la réponse HTTP de bout en bout, y compris les cas d'erreur (permission refusée, entité introuvable, contrainte métier violée). Sans ces deux niveaux, la session n'est pas terminée — la colonne "Fait quand…" décrit le critère *fonctionnel*, pas une dispense de tests.
> - **Sessions frontend** (Blocs E/F/G/M, et volet frontend du Bloc B2) : au moins un test de composant/hook (Jest + Testing Library) sur la logique non triviale (ex. calcul du panier POS), et le parcours utilisateur concerné est ajouté au corpus Playwright s'il fait partie des scénarios critiques du §18.
> - **Sessions mobile** (Bloc L) : mêmes principes que web, dans la limite de l'outillage E2E mobile disponible (Detox/Maestro) — à défaut, un scénario de test manuel documenté.
> - **Toute session à partir du Bloc C** crée ses modèles Prisma avec `organizationId` dès l'écriture initiale (§17, point M) — ce n'est jamais une session de rattrapage séparée.
> - Les sessions purement infrastructurelles (Bloc A, migrations pures) sont dispensées de tests applicatifs mais doivent rester vérifiables (ex. CI verte, `docker-compose up` réussi).

> **Estimation de charge :** lors de la revue de ce document avec l'équipe, chaque session reçoit une estimation grossière (**S / M / L**) posée collectivement — sans cet ordre de grandeur, le séquencement reste une liste ordonnée, pas un plan pilotable.

> **Jalon MVP (§17, point AD) :** la fin du **Bloc E + T01–T07** constitue la première cible commercialisable — un tenant s'inscrit, vend au POS et paie son abonnement. En cas de glissement de planning, tout ce qui suit ce jalon est négociable ; rien de ce qui le précède ne l'est.

### Bloc A (= P0) — Socle & DevOps

| # | Contenu | Fait quand… |
|---|---|---|
| S01 | Init Turborepo : `apps/api`, `apps/web`, `apps/mobile` (squelettes vides), `packages/config`, `database`, `types`, `ui`, `utils`, workspaces pnpm | `turbo build` tourne sans erreur sur des apps vides | ✅ 2026-07-18 |
| S02 | `docker-compose.yml` (Postgres + Redis) + `Dockerfile` multi-stage `api`/`web` | `docker-compose up` démarre, `apps/api` se connecte à Postgres et Redis | ✅ 2026-07-18 |
| S03 | CI (`ci.yml` : lint/typecheck/test/build) + Conventional Commits/husky/commitlint + protection de `main` | CI verte sur une PR de test | ✅ 2026-07-18 — PR `chore/s03-ci-commitlint`, 4 jobs verts. Dettes : lint-staged+prettier à câbler, config ESLint par workspace à structurer (packages/config/eslint). Protection `main` à finaliser (required checks) une fois les jobs enregistrés par GitHub. |

### Bloc B (= P1+P2) — Socle backend, auth, identité (dépend du Bloc A)

| # | Contenu | Fait quand… |
|---|---|---|
| S04 | Schéma Prisma `User`, `Role`, `Permission`, `RoleOnUser`, `PermissionOnRole` (§4, avec `organizationId` sur `User`/`Role`) + migration initiale — dépend de `Organization` (T01) | `prisma migrate dev` passe, tables visibles | ✅ 2026-07-19 — migration `20260718225308_add_user_role_permission`, 3 tests d'intégration verts (création User+Role+RoleOnUser, même email dans 2 orgs OK, doublon email même org rejeté). |
| S05 | Seed : catalogue de permissions (global), rôle admin, utilisateur admin pour une organisation de démonstration (§4) | Un admin peut être créé par script, mot de passe hashé | ✅ 2026-07-19 — `packages/database/prisma/seed.ts` idempotent : 108 permissions, organisation démo, rôle Administrateur (toutes permissions), utilisateur `admin@demo.ensemb.cm` (bcrypt coût 12). |
| S06 | `AuthModule` : login JWT access+refresh, guard `isActive`, blacklist Redis, scoping par organisation | Flow §18.1 étapes 1-3 et 6 fonctionnels |
| S07 | `RolesModule` + `PermissionGuard` + `@RequirePermission()` + interceptor `records.viewAll` | Un endpoint protégé refuse sans permission ; flow §18.11 point 4 vérifiable |
| S08 | `HealthModule` (`/health`,`/ready`) + `RealtimeModule` minimal (Gateway Socket.io, connexion authentifiée seulement, rooms scopées par organisation) | Probes OK ; un client socket authentifié se connecte |
| S08b | `AuditModule` : modèle `AuditLog`, interceptor global, branchement sur les mutations sensibles déjà en place (rôles/permissions) + préfixe global `/api/v1` (§17, points U/AA) | Une modification de permissions laisse une trace `AuditLog` complète (acteur, avant/après) ; toutes les routes répondent sous `/api/v1` |

### Bloc B2 — Multi-tenance & SaaS (dépend du Bloc B ; précède le Bloc C — T01 précède même S04)

| # | Contenu | Fait quand… |
|---|---|---|
| T01 | Schéma `Organization` + `PlatformAdmin` (§4), migration initiale | Table créée, contrainte d'unicité du sous-domaine testée — **doit précéder S04** | ✅ 2026-07-18 — PR `feat/t01-organization-schema`, 3 tests d'intégration verts contre Postgres. Note : test:integration non câblé en CI (service postgres à ajouter en S04+). |
| T02 | `TenancyModule` : middleware de résolution de tenant par sous-domaine, contexte de requête (`AsyncLocalStorage`), extension Prisma d'auto-scoping par `organizationId` | Une requête sur un sous-domaine ne retourne jamais les données d'un autre tenant (test d'isolation) |
| T03 | Row-Level Security PostgreSQL en défense en profondeur (policy `organization_id = current_setting(...)`) | Une requête SQL brute sans passer par Prisma respecte quand même l'isolation |
| T04 | Flow d'inscription (§18.0) : création `Organization` + premier utilisateur admin + validation de disponibilité du sous-domaine ; calcul de `trialEndsAt` selon la fenêtre de lancement (voir T06) | Un nouveau tenant est immédiatement utilisable après inscription, avec un plan d'essai |
| T05 | Branding : `logoUrl`/`primaryColor` sur `Organization`, endpoint public `GET /public/organizations/by-subdomain/:subdomain` | Flow §18.14 complet ; deux tenants affichent deux thèmes différents sans redéploiement |
| T06 | `Plan` + `Subscription` + `PlatformSetting` (§4), seed des plans par défaut (avec `trialDurationDays`/`trialRevenueCapAmount`), écran admin pour configurer la fenêtre de lancement, `QuotaGuard` sur les endpoints de création | Dépasser un quota renvoie une erreur explicite, pas une erreur 500 ; la fenêtre de lancement est modifiable sans déploiement (§17 point R) |
| T07 | Intégration de l'agrégateur de paiement pour la facturation récurrente : lien de paiement à la souscription, webhook de confirmation, `billing-queue` pour les échéances suivantes **et** pour la vérification du plafond de CA d'essai après chaque vente | Flow §18.15 complet en mode test de l'agrégateur, y compris la coupure anticipée par le CA (étape 6) |
| T07b | Idempotence des webhooks : modèle `WebhookEvent`, garde d'unicité `(provider, providerEventId)` sur `/webhooks/billing` et `/webhooks/payments/:organizationId` + service de chiffrement applicatif des secrets tenant (`APP_ENCRYPTION_KEY`, AES-256-GCM) (§17, points S/V) | Un webhook rejoué à l'identique est acquitté sans effet métier ; un dump SQL brut ne révèle aucun secret en clair |
| T08 | `PlatformAdminModule` : auth séparée **avec MFA TOTP obligatoire (§17, point W)**, liste des organisations, suspension/réactivation, tableau de bord (MRR, conversion, churn, factures en échec — agrégats mis en cache) | Flow §18.16 complet ; un compte tenant normal ne peut jamais y accéder, même en devinant l'URL ; la connexion sans second facteur TOTP est refusée |
| T09 | Redesign du backup : export de données par organisation (CSV/JSON) ; le `pg_dump` complet devient une tâche d'exploitation plateforme | Flow §18.12 complet ; un tenant ne peut exporter que ses propres données |
| T10 | `apps/marketing` : accueil, tarifs, FAQ, CTA vers `signup.tsx` de `apps/web` ; formulaire "se connecter" qui redirige vers `{subdomain}.monapp.com/login` | Flow §18.17 complet ; déployable indépendamment de `apps/web`/`apps/api` |

### Bloc C (= P3) — Référentiels (dépend des Blocs B et B2 ; ordre interne = ordre des FK)

| # | Contenu | Fait quand… |
|---|---|---|
| S09 | `Currency` (+ `symbolPosition`) + `Warehouse` : schéma, CRUD, écrans `settings/currencies.tsx` / `warehouses.tsx` | CRUD complet des deux, testé à l'écran |
| S10 | `Category` + `Brand` : schéma, CRUD, écrans | Idem |
| S11 | `Unit` (hiérarchie base/opérateur) + tests unitaires de conversion | Conversion carton=12×pièce testée et correcte |
| S12 | `PartnersModule` : `Client` + `Provider`, import CSV, export Excel (`excel-queue`) | Import d'un CSV modèle et export Excel fonctionnels |

### Bloc D (= P4) — Produits & stock (dépend du Bloc C)

| # | Contenu | Fait quand… |
|---|---|---|
| S13 | `UploadsModule` (`multer` + `sharp`), testé isolément | Upload d'une image redimensionnée fonctionnel avant tout branchement |
| S14 | `Product` + `ProductVariant` : schéma, CRUD, code-barres, upload branché | Création d'un produit avec variante et image |
| S15 | `ProductWarehouse` (stock par entrepôt) + colonne `version` posée (§17 point B) | Quantité par entrepôt consultable, `version` incrémentable |
| S15b | `DocumentCounter` : génération transactionnelle des références par `(organizationId, documentType)` (§17 point X) + vérification des index composites et index uniques partiels sur les tables documentaires (§4) | Test de concurrence : N créations simultanées produisent N références distinctes, sans collision ni trou inexpliqué |
| S16 | `InventoryModule` — Ajustements (+détails) | Flow §18.8 complet, `stock:updated` émis |
| S17 | `InventoryModule` — Transferts (+détails), atomicité source/destination | Flow §18.9 complet, testé avec échec simulé sur l'entrepôt destination |
| S18 | Alerte de stock bas + modèle `Notification` persistant | Flow §18.10 complet (émission + persistance + lecture) |

### Bloc E (= P5) — Ventes & POS, le cœur (dépend du Bloc D)

| # | Contenu | Fait quand… |
|---|---|---|
| S19 | `Sale` + `SaleDetail` : schéma, CRUD sans paiement ni décrément de stock | Création d'une vente "brouillon", totaux calculés côté serveur |
| S20 | `PaymentSale` + calcul automatique de `paymentStatus` | Flow §18.5 complet sur les ventes |
| S21 | Décrément de stock + verrouillage optimiste (`version`, transaction `Serializable`) branché sur la validation d'une vente | Test de concurrence : deux ventes simultanées sur le dernier exemplaire, une seule réussit |
| S21b | Annulation d'une vente validée : permission `sales.cancel`, restitution du stock sous verrouillage, statut `CANCELLED`, trace `AuditLog` (§18.18, §17 point AC) | Flow §18.18 complet ; le stock restitué est exact même en concurrence avec des ventes simultanées |
| S22 | `PosModule` : `pos/calculTotal`, `pos/CreatePOS`, recherche produit/scan côté API | Flow §18.2 complet côté API (hors écran) |
| S23 | Écran web `pos.tsx` : panier, scan douchette USB (§17 point D), paiement, impression — y compris l'attente `AWAITING_PAYMENT` du mobile money (§18.2 étape 10) | Flow §18.2 testé manuellement de bout en bout sur le web, expiration de paiement comprise |
| S23b | *(si retenue — décision §14 à acter avant P5)* Session de caisse : ouverture/clôture, fond de caisse, rattachement des ventes POS à la session, écart de caisse calculé à la clôture | Une journée de caisse s'ouvre, encaisse, se clôture avec un écart calculé et journalisé |
| S24 | Écrans web ventes classiques (liste/création/détail) + envoi email/SMS | Flow §18.3 complet |

### Bloc F (= P6) — Achats & retours (dépend du Bloc E pour les retours de vente)

| # | Contenu | Fait quand… |
|---|---|---|
| S25 | `Purchase` + `PurchaseDetail` + `PaymentPurchase`, incrément de stock à la validation | Flow §18.7 complet |
| S26 | `SaleReturn` + `PurchaseReturn` (+détails+paiements), ajustement de stock inverse | Flow §18.6 complet dans les deux sens |
| S27 | Écrans web achats + retours | Parcours testés à l'écran |

### Bloc G (= P7) — Devis, dépenses (dépend du Bloc E)

| # | Contenu | Fait quand… |
|---|---|---|
| S28 | `Quotation` + `QuotationDetail` + conversion en vente (`Change_to_Sale`) | Flow §18.4 complet |
| S29 | `ExpenseCategory` + `Expense` | CRUD simple fonctionnel |
| S30 | Écrans web devis + dépenses | Parcours testés à l'écran |
| S30b | Premier dry-run de la migration MySQL → PostgreSQL sur un extrait de données réelles (schéma documentaire stabilisé — §13 P7) | Extraction/chargement rejouables, écarts documentés ; S50 devient l'exécution finale d'un script déjà éprouvé |

### Bloc H (= P8) — Paiements & intégrations externes (dépend des Blocs E/F/G)

| # | Contenu | Fait quand… |
|---|---|---|
| S31 | Intégration de l'agrégateur de paiement (`PaymentWithCreditCard` : carte, Orange Money, MTN MoMo) sur POS et ventes classiques, identifiants propres à chaque organisation (chiffrés, §17 point S) ; **flux asynchrone** : `AWAITING_PAYMENT`, webhook idempotent, expiration configurable avec restitution du stock (§17 point V) | Un paiement carte ou mobile money test aboutit, mapping local enregistré ; un paiement non confirmé expire et restitue le stock |
| S32 | `NotificationsModule` — `email-queue` (Nodemailer) + templates | Un email de facture part réellement via la queue |
| S33 | `sms-queue` (Twilio) | Un SMS de facture part réellement via la queue |
| S34 | `pdf-queue` (Puppeteer) branché sur ventes/achats/devis/retours | PDF généré et téléchargeable pour chacun des 4 documents |
| S35 | `SettingsModule` : `Setting`, `PosSetting`, `SmtpServer` (config dynamique en base) | SMTP changeable depuis l'UI sans toucher à un fichier |

### Bloc I (= P9) — Rapports & dashboard (dépend de tous les modules métier ; volumineux, donc très découpé)

| # | Contenu | Fait quand… |
|---|---|---|
| S36 | Rapports clients (5 endpoints) + écran | Montants cohérents avec les ventes/paiements sources |
| S37 | Rapports fournisseurs (4 endpoints) + écran | Idem côté achats |
| S38 | Rapports ventes/achats/top produits + graphiques | Graphiques cohérents avec les filtres de date |
| S39 | Rapports par entrepôt (6 endpoints) | Cohérents avec le stock et les documents de l'entrepôt |
| S40 | Profit & perte, rapport du jour, dashboard, cache Redis, `dashboard:refresh` | Flow §18.13 complet, cache invalidé sur événement métier |

### Bloc J (= P10) — Permissions avancées côté UI (dépend du Bloc B)

| # | Contenu | Fait quand… |
|---|---|---|
| S41 | Écran de gestion rôles/permissions (89 droits groupés par domaine) + vérification bout en bout de `records.viewAll` sur tous les modules documentaires | Flow §18.11 complet, testé sur au moins 3 modules différents |

### Bloc K (= P11) — Réglages système, sauvegarde (dépend du Bloc H pour les réglages)

| # | Contenu | Fait quand… |
|---|---|---|
| S42 | Écrans réglages (société, POS, SMTP) | Branchement complet sur `SettingsModule` (S35) |
| S43 | `BackupModule` (`pg_dump`, `backup-queue`, purge) + écran | Flow §18.12 complet |

### Bloc L (= P12) — Application mobile (dépend du Bloc E et du Bloc B2 pour la résolution de tenant, idéalement des Blocs F/G aussi)

| # | Contenu | Fait quand… |
|---|---|---|
| S44 | Init Expo, design system (`nativewind`), écran de résolution de tenant (identifiant d'organisation avant login, §10), navigation | Login mobile fonctionnel contre la même API, brandé à l'organisation résolue |
| S45 | Écran POS mobile (scan caméra, §17 point D) branché sur l'API existante | Flow §18.2 rejoué sur mobile |
| S46 | Impression thermique mobile + repli `expo-print` | Reçu imprimé sur imprimante Bluetooth réelle ou PDF de repli |
| S47 | Pipeline `eas build`/`eas submit` intégré au CI (§12.3) | Build mobile déclenchable depuis la CI |

### Bloc M (= P13) — Frontend web complet & polish (dépend de tous les blocs backend)

| # | Contenu | Fait quand… |
|---|---|---|
| S48 | Écrans restants non couverts par les blocs précédents (people/users, résiduels) | Tous les modules de §5 ont un écran |
| S49 | i18n `fr`/`en`, thème clair/sombre, audit d'accessibilité | Contrastes et focus visibles validés |

### Bloc N (= P14) — Recette, migration, mise en production (dépend de tous les blocs précédents)

| # | Contenu | Fait quand… |
|---|---|---|
| S50 | Script de migration MySQL → PostgreSQL + table de correspondance d'IDs (§17 point A) — exécution finale du script éprouvé en S30b | Migration testée sur un jeu de données réel, relations intactes |
| S50b | Test de restauration PITR complet sur environnement jetable + validation des objectifs RPO/RTO (§12.8, §17 point AB) | Une base restaurée à un instant T arbitraire est vérifiée cohérente (comptages, intégrité référentielle, échantillon de documents) |
| S51 | Exécution intégrale de la checklist §15 | Toutes les cases cochées |
| S52 | Pipelines de déploiement `staging`/`prod`, monitoring, bascule (§12.3/§12.5) | Bascule effectuée, dashboards actifs |

> **Comment utiliser ce découpage :** ouvrir une session = annoncer son numéro ("on attaque S14"), relire uniquement les sections référencées (pas tout le document), livrer jusqu'à la définition de "fait", committer, passer à la suivante. Si une session déborde largement sa portée annoncée, c'est le signal qu'elle doit elle-même être re-découpée avant de continuer.
