# Roadmap technique — Reproduction d'Ensemb 

**Stack cible :** NestJS · TypeScript · Prisma · PostgreSQL · Redis · BullMQ · Socket.io · React · Vite · TailwindCSS · shadcn/ui · TanStack Router · TanStack Query · Zustand · React Native · Expo · Turborepo · Docker · GitHub Actions

> Ce document remplace la version agnostique précédente. La stack étant désormais figée, chaque phase liste les modules NestJS, modèles Prisma, écrans React, files BullMQ, événements Socket.io et standards DevOps (CI/CD, conteneurisation, observabilité) concrets à livrer. Il sert à la fois de **roadmap de projet** et de **fichier de référence technique** (architecture, schéma de données, conventions) à garder ouvert pendant tout le développement.

> **Révision du 16 juillet 2026 (revue sécurité & exploitation)** — décisions ajoutées en §17 : chiffrement des secrets tenant (S), piège RLS/pooling (T), journal d'audit (U), paiements mobile money asynchrones & idempotence des webhooks (V), MFA plateforme (W), génération des références (X), stockage objet (Y), workers BullMQ dédiés (Z), versionnement d'API (AA), continuité/PITR (AB), annulation de document (AC), jalon MVP (AD), mode hors-ligne POS assumé hors périmètre (AE). Les sessions intercalaires S08b, T07b, S15b, S21b, S23b, S30b et S50b (§19) portent leur implémentation.

---


> **Extrait ciblé — Architecture & socle (§0–§12).** Document découpé pour lecture sélective par Claude Code ; la version intégrale fait référence.

## 0. Résumé exécutif

Le système d'origine est un ERP léger multi-entrepôt avec point de vente intégré : catalogue produit à unités convertibles, stock par entrepôt, ventes/achats/devis/retours/transferts/ajustements, paiements multi-méthodes, rapports, 89 permissions granulaires, notifications email/SMS, export Excel/PDF.

La réécriture vise la même couverture fonctionnelle, transformée en **plateforme SaaS multi-tenant** avec une architecture moderne :

- **Multi-tenant dès la racine du schéma** : chaque client (organisation) a ses propres données, isolées par `organizationId` + Row-Level Security PostgreSQL, résolu par sous-domaine (`{tenant}.monapp.com`) — voir §4, §5, §17.
- **Personnalisation par organisation** : logo, couleurs et thème appliqués à l'exécution, sans build séparé par client — voir §3, §9.
- **Facturation SaaS par abonnement** (plans, quotas, historique de facturation), payée par carte bancaire et mobile money (Orange Money, MTN MoMo) via un agrégateur régional plutôt que Stripe — Stripe n'acceptant pas de compte marchand camerounais, ce choix vaut aussi pour l'encaissement du POS lui-même (remplace l'intégration Stripe de l'original) — voir §5, §17.
- **Backend** NestJS modulaire, un module par domaine métier, avec une séparation claire Controller → Service → Repository (Prisma).
- **Temps réel natif** via Socket.io : stock synchronisé en direct entre plusieurs caisses/entrepôts d'un même tenant.
- **Traitement asynchrone** via BullMQ : emails, SMS, PDF, exports Excel, sauvegardes, facturation récurrente — déchargés du cycle requête/réponse.
- **App mobile native** via Expo + React Native, branchée sur la même API et le même canal temps réel que le web.
- **Monorepo Turborepo** pour partager types, schéma Prisma et composants UI entre `api`, `web` et `mobile`.
- **Standards DevOps dès le départ** : conteneurisation Docker, pipelines CI/CD (lint/test/build/déploiement), migrations Prisma versionnées et observabilité (logs structurés, métriques, alerting, health checks) — voir §12.
- **Sécurité by design** : chiffrement applicatif des secrets tenant stockés en base, journal d'audit transverse des mutations sensibles, MFA pour le staff plateforme, webhooks de paiement idempotents — voir §17, points S à W.

> Les sections qui suivent décrivent l'architecture (modules, schéma, endpoints). Pour la logique métier telle qu'elle se déroule réellement à l'écran — étape par étape, du point de vue de l'utilisateur — voir **§18 Parcours utilisateurs**, qui est le fil conducteur à garder en tête pendant l'implémentation : l'architecture sert ces parcours, pas l'inverse.

---

## 1. Rôle de chaque brique de la stack

| Brique | Rôle dans le projet |
|---|---|
| **NestJS + TypeScript** | API REST (+ Gateway WebSocket), architecture modulaire (Module → Controller → Service → Repository via Prisma) |
| **Prisma** | ORM + migrations + client typé généré à partir d'un schéma unique, partagé par tout le backend |
| **PostgreSQL** | Base de données transactionnelle relationnelle (remplace MySQL, meilleur support des contraintes/JSON/enums), **Row-Level Security** pour l'isolation multi-tenant |
| **Redis** | Cache par tenant (settings, permissions, sessions), backend de BullMQ, rate limiting, pub/sub pour Socket.io multi-instance |
| **Agrégateur de paiement régional** (ex. CinetPay) | Carte bancaire (Visa/Mastercard) + mobile money (Orange Money, MTN MoMo) sous une seule API — pour la facturation SaaS de la plateforme *et* l'encaissement du POS par chaque tenant (voir §17) |
| **BullMQ** | Files d'attente pour les tâches longues/asynchrones : emails, SMS, PDF, export Excel, sauvegarde DB |
| **Socket.io** | Canal temps réel : mise à jour de stock en direct, notifications d'alerte, rafraîchissement dashboard |
| **React + Vite** | SPA web, build rapide en dev, bundling optimisé en prod |
| **TailwindCSS + shadcn/ui** | Système de design utilitaire + bibliothèque de composants accessibles |
| **TanStack Router** | Routing typé du frontend web, code-splitting par route |
| **TanStack Query** | Cache et synchronisation des données serveur, invalidation ciblée par clé de requête |
| **Zustand** | État client pur (panier POS en cours, sidebar, préférences UI) — état serveur laissé à TanStack Query |
| **React Native + Expo** | Application mobile POS connectée, consommant la même API REST et le même canal Socket.io que le web |
| **Turborepo** | Orchestration du monorepo : cache de build, pipelines `build`/`lint`/`test`/`dev` partagés |
| **Docker** | Conteneurisation de chaque app (`api`, `web`) pour un environnement reproductible dev → staging → prod |
| **GitHub Actions** | Pipelines CI/CD : lint, typecheck, tests, build, déploiement automatisé |

---

## 2. Monorepo Turborepo — arborescence

```
ensemb/
├─ apps/
│  ├─ api/                      # NestJS
│  │  ├─ src/
│  │  │  ├─ modules/
│  │  │  │  ├─ auth/
│  │  │  │  ├─ users/
│  │  │  │  ├─ roles/
│  │  │  │  ├─ catalog/         # products, categories, brands, units, variants
│  │  │  │  ├─ inventory/       # stock, adjustments, transfers
│  │  │  │  ├─ sales/
│  │  │  │  ├─ pos/
│  │  │  │  ├─ purchases/
│  │  │  │  ├─ quotations/
│  │  │  │  ├─ returns/         # sale & purchase returns
│  │  │  │  ├─ payments/
│  │  │  │  ├─ expenses/
│  │  │  │  ├─ partners/        # clients, providers
│  │  │  │  ├─ reports/
│  │  │  │  ├─ settings/
│  │  │  │  ├─ notifications/   # email + sms (consumers BullMQ)
│  │  │  │  ├─ backup/
│  │  │  │  └─ realtime/        # Gateway Socket.io
│  │  │  ├─ common/             # guards, interceptors, decorators, filters
│  │  │  ├─ queues/              # définitions BullMQ (producers)
│  │  │  └─ main.ts
│  │  └─ test/
│  ├─ web/                      # React + Vite — app tenant ({subdomain}.monapp.com) + admin plateforme (admin.monapp.com)
│  │  ├─ src/
│  │  │  ├─ routes/              # arborescence TanStack Router (fichiers = routes)
│  │  │  ├─ features/            # un dossier par domaine (products, pos, sales, reports…)
│  │  │  ├─ platform-admin/       # écrans réservés au staff plateforme (§18.16), layout et guard séparés
│  │  │  ├─ stores/               # Zustand (cart.store.ts, ui.store.ts…)
│  │  │  ├─ hooks/                # hooks TanStack Query par ressource
│  │  │  ├─ components/           # composants partagés spécifiques à web
│  │  │  └─ main.tsx
│  │  └─ vite.config.ts
│  ├─ marketing/                # React + Vite — site public (monapp.com) : accueil, tarifs, inscription
│  │  ├─ src/
│  │  │  ├─ pages/                # home, pricing, features, faq, blog (optionnel)
│  │  │  └─ main.tsx
│  │  └─ vite.config.ts
│  └─ mobile/                   # Expo + React Native
│     ├─ app/                    # expo-router (écrans)
│     ├─ src/
│     │  ├─ features/pos/        # écran caisse (consomme l'API via TanStack Query)
│     │  └─ stores/
│     └─ app.json
├─ packages/
│  ├─ database/                 # schema.prisma + migrations + seed + client exporté
│  ├─ types/                    # schémas zod exportés depuis les DTOs nestjs-zod (source unique) + client API généré depuis l'OpenAPI
│  ├─ ui/                       # composants shadcn/ui partagés (web) — design system
│  ├─ config/                   # tsconfig, eslint, tailwind.config partagés
│  └─ utils/                    # helpers communs (formatage devise, conversion d'unités…)
├─ .github/
│  └─ workflows/                # ci.yml, deploy-staging.yml, deploy-prod.yml
├─ docker-compose.yml            # postgres + redis + api + web (environnement de dev local)
├─ turbo.json
├─ package.json                 # workspaces npm/pnpm
└─ pnpm-workspace.yaml
```

**Pipelines Turborepo (`turbo.json`) à définir :** `dev` (persistant, sans cache), `build` (dépend de `^build`, cache activé), `lint`, `typecheck`, `test:unit`, `test:integration` (dépend de `db:generate` + de la disponibilité de la Postgres/Redis de test, §16), `db:generate` (génère le client Prisma avant tout `build`/`dev`/`test:*` qui en dépend).

`apps/api`, `apps/web` et `apps/marketing` embarquent chacun un `Dockerfile` multi-stage (`deps` → `build` → `runner`) — détail complet en §12. `apps/marketing` est déployé **indépendamment** des deux autres (cycle de vie différent : une faute de frappe sur la page tarifs ne doit jamais nécessiter de redéployer l'app tenant).

---

## 3. Design system — vert par défaut, personnalisable par organisation

Le vert ci-dessous est le **thème par défaut de la plateforme** : site marketing, panneau d'administration plateforme (§5 `PlatformAdminModule`), et thème initial de toute nouvelle organisation tant qu'elle n'a pas défini son propre logo/couleurs (§4 `Organization.primaryColor` etc.). Chaque tenant peut ensuite personnaliser son propre thème sans redéploiement.

**Architecture de theming runtime (obligatoire pour le multi-tenant) :** les couleurs ne sont **pas** figées à la compilation dans `tailwind.config.ts` — Tailwind ne fournit que l'échelle par défaut et la mécanique des classes utilitaires (`bg-primary`, `text-primary`…). La couleur réellement affichée vient des **variables CSS shadcn/ui** (`--primary`, `--ring`…), écrites sur `:root` **au chargement de l'app**, une fois l'organisation résolue par sous-domaine (§9) : `document.documentElement.style.setProperty('--primary', tenant.primaryColorHsl)`. Deux tenants sur le même bundle JS peuvent ainsi afficher deux thèmes différents.

Échelle par défaut de la plateforme, définie en HSL pour coller aux conventions shadcn/ui :

| Nuance | Hex | Usage |
|---|---|---|
| `green-50` | `#F0FBF4` | Fonds de badges/alerts clairs |
| `green-100` | `#DCF5E3` | Hover léger sur fond clair |
| `green-200` | `#BAEAC8` | Bordures discrètes |
| `green-300` | `#8AD9A4` | États désactivés (dark mode) |
| `green-400` | `#55C17D` | Primary en thème sombre |
| `green-500` | `#2FA75E` | **Primary — couleur de marque** |
| `green-600` | `#1F8A4B` | Hover sur primary (thème clair) |
| `green-700` | `#196F3D` | Active/pressed |
| `green-800` | `#185A33` | Texte sur fond clair très saturé |
| `green-900` | `#154A2C` | Fonds sombres accentués |
| `green-950` | `#09291A` | Fond de app bar en thème sombre |

`packages/config/tailwind.config.ts` (extrait) :

```ts
export default {
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#F0FBF4", 100: "#DCF5E3", 200: "#BAEAC8", 300: "#8AD9A4",
          400: "#55C17D", 500: "#2FA75E", 600: "#1F8A4B", 700: "#196F3D",
          800: "#185A33", 900: "#154A2C", 950: "#09291A",
        },
      },
    },
  },
};
```

Variables CSS shadcn/ui (`apps/web/src/index.css`) :

```css
:root {
  --primary: 144 56% 42%;          /* #2FA75E */
  --primary-foreground: 0 0% 100%;
  --ring: 144 56% 42%;
}
.dark {
  --primary: 142 47% 55%;          /* #55C17D */
  --primary-foreground: 142 47% 8%;
  --ring: 142 47% 55%;
}
```

**Sémantique de statut** (à garder distincte de la couleur de marque, qu'elle soit le vert par défaut ou une couleur choisie par le tenant, pour ne pas la diluer) : alerte `amber-500`, critique `red-500`, info `sky-500`. Le succès (`success`) réutilise la couleur de marque active — vert par défaut, ou couleur du tenant s'il en a choisi une.

**Limites à respecter à l'écran de personnalisation (§18)** : la couleur choisie par le tenant doit rester utilisable comme fond de bouton avec du texte blanc — un contrôle de contraste (WCAG AA, ratio ≥ 4.5:1) est appliqué côté client à la sélection, avec suggestion d'une teinte plus foncée si le ratio est insuffisant.

---

## 4. Modèle de données Prisma (34 modèles)

Schéma condensé (types PostgreSQL natifs, `@@map` pour garder des noms de table lisibles, `deletedAt` en soft delete généralisé). À éclater dans `packages/database/schema.prisma`.

> **Décisions d'architecture (§17, points A, M et R) :** tous les identifiants sont des **UUID** (`String @id @default(uuid()) @db.Uuid`). Toute table métier porte un `organizationId` et n'est jamais lue/écrite sans lui (Prisma middleware + Row-Level Security, §5/§17) — sauf les tables explicitement **globales** (`Permission`, `Currency`, `Plan`, `PlatformSetting`), partagées par toutes les organisations, et les tables **hors tenant** (`Organization`, `PlatformAdmin`, `Subscription`, `Invoice`) qui décrivent les tenants eux-mêmes plutôt que leurs données. Le seed assigne les permissions aux rôles en filtrant par `name`, pas par ID. **Index (décision transverse, posée dès la migration initiale — P2)** : toute table documentaire porte des index composites `@@index([organizationId, date])` et `@@index([organizationId, deletedAt])` — l'auto-scoping par tenant rend `organizationId` colonne de tête obligatoire, et ces index ne se rattrapent pas en optimisation tardive. Les contraintes `@@unique([organizationId, code])` combinées au soft delete sont matérialisées en **index uniques partiels** (`WHERE deleted_at IS NULL`) via migration SQL manuelle, Prisma ne les exprimant pas dans le schéma — sans quoi le code d'un enregistrement supprimé resterait à jamais inutilisable.

```prisma
// ─── Tenants & plateforme (hors périmètre organizationId) ───────────────────

model Organization {
  id           String             @id @default(uuid()) @db.Uuid
  name         String
  subdomain    String             @unique   // ex. "boutique-durand" → boutique-durand.monapp.com
  customDomain String?            @unique   // ex. "caisse.boutique-durand.com" — hors périmètre initial, voir §17 point O
  logoUrl      String?
  primaryColor String?                      // HSL/hex appliqué en --primary au runtime (§3)
  status       OrganizationStatus @default(TRIALING)
  subscription Subscription?
  createdAt    DateTime @default(now())
  deletedAt    DateTime?
  @@map("organizations")
}

model PlatformAdmin {
  id         String   @id @default(uuid()) @db.Uuid
  email      String   @unique
  password   String
  totpSecret String?            // MFA TOTP obligatoire, enrôlé à la première connexion — §17 point W
  createdAt  DateTime @default(now())
  @@map("platform_admins")     // auth totalement séparée des utilisateurs tenant — voir §17
}

model PlatformSetting {
  id                String    @id @default("00000000-0000-0000-0000-000000000003") @db.Uuid   // singleton plateforme, UUID fixe (§17 point A)
  launchPromoEndsAt DateTime?   // fin de la fenêtre de lancement (§17 point R) ; null ou passée = fenêtre terminée, règle standard applicable
  @@map("platform_settings")
}

model Plan {
  id                    String   @id @default(uuid()) @db.Uuid
  name                  String   @unique     // "Essai", "Starter", "Pro"
  priceMonthly          Decimal
  priceYearly           Decimal
  maxUsers              Int?
  maxWarehouses         Int?
  maxProducts           Int?
  trialDurationDays     Int?     @default(30)    // durée standard de l'essai hors fenêtre de lancement
  trialRevenueCapAmount Decimal?                 // seuil de CA cumulé qui coupe l'essai plus tôt ; null = pas de plafond ; valeur modifiable par le staff plateforme, jamais figée dans le code (§17 point R)
  isActive              Boolean  @default(true)
  subscriptions         Subscription[]
  @@map("plans")
}

model Subscription {
  id                 String             @id @default(uuid()) @db.Uuid
  organizationId     String             @unique @db.Uuid
  organization        Organization       @relation(fields: [organizationId], references: [id])
  planId             String             @db.Uuid
  plan               Plan               @relation(fields: [planId], references: [id])
  status             SubscriptionStatus @default(TRIALING)
  providerCustomerId String?                    // identifiant client chez l'agrégateur de paiement
  trialEndsAt        DateTime?
  trialEndedReason   TrialEndedReason?          // DURATION / REVENUE_CAP / null tant que l'essai est en cours
  currentPeriodEnd   DateTime?
  invoices           Invoice[]
  createdAt          DateTime @default(now())
  @@map("subscriptions")
}

model Invoice {
  id                String        @id @default(uuid()) @db.Uuid
  subscriptionId    String        @db.Uuid
  subscription      Subscription  @relation(fields: [subscriptionId], references: [id])
  amount            Decimal
  currency          String        @default("XAF")
  status            InvoiceStatus @default(PENDING)
  providerPaymentId String?                       // référence de transaction chez l'agrégateur
  dueAt             DateTime
  paidAt            DateTime?
  createdAt         DateTime @default(now())
  @@map("invoices")
}

// ─── Référentiels globaux, partagés par toutes les organisations ───────────

model Permission {
  id    String @id @default(uuid()) @db.Uuid
  name  String @unique   // ex: "sales.view", "pos.access", "reports.profit", "billing.manage"
  label String?
  roles PermissionOnRole[]
  @@map("permissions")
}

model Currency {
  id             String         @id @default(uuid()) @db.Uuid
  code           String         @unique
  name           String
  symbol         String
  symbolPosition SymbolPosition @default(BEFORE)   // position du symbole par rapport au montant
  @@map("currencies")
}

// ─── Données par organisation (organizationId obligatoire) ──────────────────

model User {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @db.Uuid
  firstname      String
  lastname       String
  username       String
  email          String
  password       String
  avatar         String?
  phone          String?
  isActive       Boolean  @default(true)
  roles          RoleOnUser[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  deletedAt      DateTime?
  @@unique([organizationId, email])
  @@unique([organizationId, username])
  @@map("users")
}

model Role {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @db.Uuid
  name           String
  label          String?
  description    String?
  status         Boolean  @default(true)
  permissions    PermissionOnRole[]
  users          RoleOnUser[]
  @@unique([organizationId, name])
  @@map("roles")
}

model RoleOnUser        { userId String @db.Uuid; roleId String @db.Uuid; @@id([userId, roleId]) }
model PermissionOnRole  { roleId String @db.Uuid; permissionId String @db.Uuid; @@id([roleId, permissionId]) }

model Client {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @db.Uuid
  name           String
  code           Int                       // code client affiché, unique par organisation
  email          String?
  country        String?
  city           String?
  phone          String?
  address        String?
  deletedAt      DateTime?
  @@unique([organizationId, code])
  @@map("clients")
}

model Provider {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @db.Uuid
  name           String
  code           Int                       // code fournisseur affiché, unique par organisation
  email          String?
  phone          String?
  country        String?
  city           String?
  address        String?
  deletedAt      DateTime?
  @@unique([organizationId, code])
  @@map("providers")
}

model Warehouse {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @db.Uuid
  name           String
  city           String?
  mobile         String?
  zip            String?
  email          String?
  country        String?
  deletedAt      DateTime?
  @@map("warehouses")
}

model Category { id String @id @default(uuid()) @db.Uuid; organizationId String @db.Uuid; code String; name String; products Product[]; @@map("categories") }
model Brand    { id String @id @default(uuid()) @db.Uuid; organizationId String @db.Uuid; name String; description String?; image String?; products Product[]; @@map("brands") }

model Unit {
  id             String  @id @default(uuid()) @db.Uuid
  organizationId String  @db.Uuid
  name           String
  shortName      String
  baseUnitId     String? @db.Uuid
  baseUnit       Unit?   @relation("UnitHierarchy", fields: [baseUnitId], references: [id])
  subUnits       Unit[]  @relation("UnitHierarchy")
  operator       String  @default("*")   // "*" ou "/"
  operatorValue  Decimal @default(1) @db.Decimal(14,6)   // jamais Float : ce facteur multiplie quantités et montants (cohérence avec la règle Decimal, §17 point A)
  @@map("units")
}

model Product {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @db.Uuid
  code           String
  barcodeType    String?
  name           String
  cost           Decimal  @db.Decimal(14,3)
  price          Decimal  @db.Decimal(14,3)
  categoryId     String   @db.Uuid
  category       Category @relation(fields: [categoryId], references: [id])
  brandId        String?  @db.Uuid
  unitId         String?  @db.Uuid
  unitSaleId     String?  @db.Uuid
  unitPurchaseId String?  @db.Uuid
  taxRate        Decimal? @default(0)
  taxMethod      String   @default("percentage")
  image          String?
  note           String?
  stockAlert     Int?     @default(0)
  isVariant      Boolean  @default(false)
  isActive       Boolean  @default(true)
  variants       ProductVariant[]
  stocks         ProductWarehouse[]
  deletedAt      DateTime?
  @@unique([organizationId, code])
  @@map("products")
}

model ProductVariant {
  id        String  @id @default(uuid()) @db.Uuid
  productId String  @db.Uuid
  product   Product @relation(fields: [productId], references: [id])
  name      String?
  // Pas de champ de quantité ici : l'unique source de vérité du stock (variante comprise)
  // est ProductWarehouse via productVariantId — deux compteurs divergeraient inévitablement.
  @@map("product_variants")
}

model ProductWarehouse {
  id               String   @id @default(uuid()) @db.Uuid
  productId        String   @db.Uuid
  warehouseId      String   @db.Uuid
  productVariantId String?  @db.Uuid
  quantity         Decimal  @default(0)
  version          Int      @default(0)   // verrouillage optimiste — §17 point B
  product          Product  @relation(fields: [productId], references: [id])
  warehouse        Warehouse @relation(fields: [warehouseId], references: [id])
  @@unique([productId, warehouseId, productVariantId])
  @@map("product_warehouse")
}

// Documents commerciaux — même patron pour Sale / Purchase / Quotation / SaleReturn / PurchaseReturn / Transfer / Adjustment
model Sale {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @db.Uuid
  reference      String                  // unique par organisation, pas globalement
  date           DateTime               // stocké en UTC — voir §17, point F (fuseaux horaires)
  isPos          Boolean  @default(false)
  userId         String   @db.Uuid
  clientId       String   @db.Uuid
  warehouseId    String   @db.Uuid
  taxRate        Decimal? @default(0)
  taxAmount      Decimal? @default(0)
  discount       Decimal? @default(0)
  shipping       Decimal? @default(0)
  grandTotal     Decimal  @default(0)
  paidAmount     Decimal  @default(0)
  paymentStatus  PaymentStatus @default(UNPAID)
  status         DocumentStatus @default(PENDING)
  notes          String?
  details        SaleDetail[]
  payments       PaymentSale[]
  deletedAt      DateTime?
  @@unique([organizationId, reference])
  @@map("sales")
}

model SaleDetail {
  id               String  @id @default(uuid()) @db.Uuid
  saleId           String  @db.Uuid
  productId        String  @db.Uuid
  productVariantId String? @db.Uuid
  saleUnitId       String? @db.Uuid
  price            Decimal
  taxAmount        Decimal? @default(0)
  taxMethod        String?  @default("percentage")
  discount         Decimal? @default(0)
  discountMethod   String?  @default("percentage")
  quantity         Decimal
  total            Decimal
  sale             Sale    @relation(fields: [saleId], references: [id])
  @@map("sale_details")
}

model PaymentSale {
  id        String   @id @default(uuid()) @db.Uuid
  saleId    String   @db.Uuid
  userId    String   @db.Uuid
  date      DateTime
  reference String
  amount    Decimal
  method    PaymentMethod
  change    Decimal? @default(0)
  notes     String?
  sale      Sale     @relation(fields: [saleId], references: [id])
  @@map("payment_sales")
}

// … Purchase / PurchaseDetail / PaymentPurchase, Quotation / QuotationDetail,
//    SaleReturn / SaleReturnDetail / PaymentSaleReturn,
//    PurchaseReturn / PurchaseReturnDetail / PaymentPurchaseReturn,
//    Transfer / TransferDetail, Adjustment / AdjustmentDetail
//    suivent rigoureusement le même schéma que Sale/SaleDetail/PaymentSale ci-dessus,
//    avec les mêmes conventions (identifiants UUID, `organizationId` sur le document
//    d'en-tête uniquement — les tables `*_details` héritent du tenant via leur parent)
//    (voir §13 Phase P6/P7 pour le détail complet des champs).

model ExpenseCategory { id String @id @default(uuid()) @db.Uuid; organizationId String @db.Uuid; userId String @db.Uuid; name String; description String?; @@map("expense_categories") }
model Expense {
  id                String   @id @default(uuid()) @db.Uuid
  organizationId    String   @db.Uuid
  date              DateTime
  reference         String
  userId            String   @db.Uuid
  expenseCategoryId String   @db.Uuid
  warehouseId       String   @db.Uuid
  details           String
  amount            Decimal
  @@map("expenses")
}

model PaymentWithCreditCard {
  id                String @id @default(uuid()) @db.Uuid
  paymentSaleId     String @db.Uuid
  customerId        String @db.Uuid
  provider          PaymentProvider   // CARD / ORANGE_MONEY / MTN_MOMO
  providerCustomerId String
  providerTransactionId String
  @@map("payment_with_credit_card")
}

// ─── Séquences de références, idempotence des webhooks, journal d'audit ─────

model DocumentCounter {
  organizationId String @db.Uuid
  documentType   String            // "SALE", "PURCHASE", "QUOTATION", "SALE_RETURN", "TRANSFER"…
  lastValue      Int    @default(0)
  @@id([organizationId, documentType])
  @@map("document_counters")       // incrémenté DANS la transaction de création du document — §17 point X
}

model WebhookEvent {
  id              String    @id @default(uuid()) @db.Uuid
  provider        String                          // "PAYMENT_AGGREGATOR"
  providerEventId String                          // identifiant d'événement fourni par l'agrégateur
  payload         Json
  processedAt     DateTime?
  createdAt       DateTime  @default(now())
  @@unique([provider, providerEventId])           // un webhook rejoué est acquitté puis ignoré, jamais retraité — §17 point V
  @@map("webhook_events")
}

model AuditLog {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String?  @db.Uuid                // null pour les actions du staff plateforme
  actorType      String                            // "USER" | "PLATFORM_ADMIN" | "SYSTEM"
  actorId        String?  @db.Uuid
  action         String                            // "sale.cancel", "role.permissions.update", "organization.suspend"…
  entity         String
  entityId       String?  @db.Uuid
  before         Json?                             // état avant/après pour les mutations sensibles
  after          Json?
  createdAt      DateTime @default(now())
  @@index([organizationId, createdAt])
  @@index([entity, entityId])
  @@map("audit_logs")                              // alimenté par l'interceptor d'AuditModule — §17 point U
}

model Setting {
  id                 String   @id @default(uuid()) @db.Uuid
  organizationId     String   @unique @db.Uuid   // une ligne de réglages par organisation
  email              String?
  currencyId         String?  @db.Uuid
  companyName        String?
  companyPhone       String?
  companyAddress     String?
  defaultClientId    String?  @db.Uuid
  defaultWarehouseId String?  @db.Uuid
  defaultLanguage    String   @default("fr")
  timezone           String   @default("Africa/Douala")   // voir §17, point F
  @@map("settings")
}

model PosSetting {
  id             String  @id @default(uuid()) @db.Uuid
  organizationId String  @unique @db.Uuid   // une ligne d'options POS par organisation
  noteCustomer   String  @default("Merci pour votre achat")
  showNote       Boolean @default(true)
  showBarcode    Boolean @default(true)
  showDiscount   Boolean @default(true)
  showCustomer   Boolean @default(true)
  showEmail      Boolean @default(true)
  showPhone      Boolean @default(true)
  showAddress    Boolean @default(true)
  @@map("pos_settings")
}

model SmtpServer {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @unique @db.Uuid   // chaque organisation configure son propre SMTP
  host           String
  port           Int
  username       String
  password       String             // chiffré applicativement (AES-256-GCM) avant écriture — §17 point S
  encryption     String
  @@map("smtp_servers")
}

model Notification {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @db.Uuid
  userId         String   @db.Uuid                // destinataire (ou rôle ciblé via une table de jonction si diffusion large)
  type           String                            // "stock.lowAlert", "backup.completed"…
  payload        Json
  readAt         DateTime?
  createdAt      DateTime @default(now())
  @@map("notifications")                          // persiste ce que Socket.io ne fait que diffuser en direct — voir §17, point I
}

enum OrganizationStatus { TRIALING ACTIVE SUSPENDED CANCELED }
enum SubscriptionStatus { TRIALING ACTIVE PAST_DUE CANCELED }
enum TrialEndedReason   { DURATION REVENUE_CAP MANUAL }
enum InvoiceStatus      { PENDING PAID FAILED }
enum PaymentProvider    { CARD ORANGE_MONEY MTN_MOMO }
enum SymbolPosition     { BEFORE AFTER }
enum PaymentStatus      { PAID PARTIAL UNPAID }
enum DocumentStatus     { PENDING AWAITING_PAYMENT COMPLETED CANCELLED }   // AWAITING_PAYMENT : vente en attente de confirmation mobile money (§17 point V) ; CANCELLED : annulé avec restitution de stock (§18.18)
enum PaymentMethod      { CASH CARD MOBILE_MONEY BANK_TRANSFER }
```

> **Isolation des données :** un client Prisma étendu (`$extends`) intercepte chaque requête sur les modèles ci-dessus marqués "par organisation" pour y injecter automatiquement `WHERE organizationId = <tenant courant>` (résolu par le middleware de sous-domaine, §5) — aucun repository n'a besoin d'y penser lui-même. En défense en profondeur, une policy PostgreSQL Row-Level Security (`CREATE POLICY ... USING (organization_id = current_setting('app.current_tenant')::uuid)`) protège aussi contre une requête SQL qui contournerait Prisma.

> Les tables de session/token (`sessions`, `refresh_tokens`) ne sont pas listées ici : voir §5 (module `auth`) pour le choix JWT access + refresh token en base.

---

## 5. Découpage des modules NestJS

| Module | Responsabilité | Dépend de |
|---|---|---|
| `TenancyModule` | Middleware de résolution de tenant par sous-domaine, contexte de requête (`AsyncLocalStorage`), extension Prisma d'auto-scoping par `organizationId` | Redis (cache du mapping sous-domaine → organisation) |
| `OrganizationsModule` | CRUD organisation (nom, sous-domaine), branding (logo/couleurs), auto-provisionnement à l'inscription | `TenancyModule`, `UploadsModule` |
| `BillingModule` | Plans, abonnements, factures ; intégration agrégateur de paiement pour la facturation récurrente ; `QuotaGuard` (limites par plan) ; politique d'essai (fenêtre de lancement `PlatformSetting.launchPromoEndsAt`, puis plafond de durée **et** de chiffre d'affaires par plan, §17 point R) | `OrganizationsModule`, `QueueModule` |
| `PlatformAdminModule` | Auth et endpoints séparés pour le staff plateforme : liste des organisations, statut d'abonnement, suspension/réactivation, **tableau de bord business** (MRR, nombre d'organisations actives/en essai, taux de conversion essai→payant, churn, factures en échec à relancer), agrégats mis en cache et recalculés périodiquement (comme `ReportsModule`, mais tous tenants confondus) | `PlatformAdmin` (auth propre, hors `AuthModule` tenant), Redis |
| `AuthModule` | Login, refresh token, guard JWT, vérification compte actif (`isActive`) — scoping par organisation dès la résolution du sous-domaine | `UsersModule`, `TenancyModule`, Redis (blacklist token) |
| `UsersModule` | CRUD utilisateurs, profil, activation/désactivation | `RolesModule` |
| `RolesModule` | CRUD rôles par organisation, assignation des permissions du catalogue global, guard `@RequirePermission()` | Prisma |
| `CatalogModule` | Produits, variantes, catégories, marques, unités, code-barres, import/export | `InventoryModule`, `UploadsModule` |
| `InventoryModule` | Stock par entrepôt, ajustements, transferts, **verrouillage optimiste** sur `ProductWarehouse.version` (voir §17, point B) | `CatalogModule`, `RealtimeModule` |
| `UploadsModule` | Upload/redimensionnement d'images (produits, marques, logo société, avatar) via `multer` + `sharp`, stockage **objet S3-compatible tranché** (préfixe par `organizationId`, URLs signées pour les téléchargements) — le stockage local sur disque est éliminatoire en multi-instance conteneurisée (§17 point Y) | — |
| `PartnersModule` | Clients, fournisseurs, import/export | — |
| `SalesModule` | Ventes classiques, calcul des totaux, statut de paiement | `InventoryModule`, `PaymentsModule` |
| `PosModule` | Endpoint caisse : recherche produit, calcul total, création vente POS **dans une transaction Prisma `Serializable`** qui relit et incrémente `ProductWarehouse.version` (empêche la survente entre caisses simultanées, voir §17, point B) | `SalesModule`, `RealtimeModule` |
| `PurchasesModule` | Achats, réception stock | `InventoryModule`, `PaymentsModule` |
| `QuotationsModule` | Devis, conversion en vente | `SalesModule` |
| `ReturnsModule` | Retours de vente et d'achat | `SalesModule`, `PurchasesModule` |
| `PaymentsModule` | Paiements (espèces, carte et mobile money via l'agrégateur régional), calcul de la monnaie rendue ; **flux asynchrone** pour le mobile money : initiation → vente `AWAITING_PAYMENT` (stock réservé) → confirmation par webhook idempotent (`WebhookEvent`) ou expiration avec restitution du stock (§17 point V) | SDK agrégateur (ex. CinetPay), `QueueModule` |
| `ExpensesModule` | Dépenses + catégories | — |
| `ReportsModule` | Agrégats (top produits, profit&perte, rapports par entrepôt), cache Redis sur les requêtes lourdes | Redis |
| `SettingsModule` | Réglages société, POS, SMTP dynamique — un jeu de réglages par organisation, en base, jamais dans un fichier `.env` | — |
| `NotificationsModule` | Consumers BullMQ : envoi email (nodemailer) et SMS (Twilio) | `QueueModule` |
| `BackupModule` | Export des données d'une organisation (CSV/JSON de ses propres tables) — le `pg_dump` complet de la base partagée devient une tâche d'exploitation plateforme, plus une fonctionnalité exposée à un tenant (voir §17, point N) | `QueueModule` |
| `RealtimeModule` | Gateway Socket.io : diffusion des événements stock/ventes/alertes | Redis (adapter pub/sub) |
| `QueueModule` | Déclaration des queues BullMQ (producers), configuration Redis | Redis |
| `HealthModule` | Endpoints `/health` (liveness) et `/ready` (readiness : DB + Redis joignables) pour les probes de l'orchestrateur | Prisma, Redis |
| `AuditModule` | Interceptor global d'audit : journalise dans `AuditLog` toute mutation sensible (suppression/annulation de document, changement de rôles/permissions, modification de réglages, suspension d'organisation), avec acteur, entité et diff avant/après (§17 point U) | Prisma |

**Autorisation :** un guard NestJS générique `PermissionGuard` + décorateur `@RequirePermission('sales.view')` porte le contrôle d'accès par permission sur chaque endpoint. La règle transverse *"voir uniquement mes documents"* (permission spéciale `records.viewAll`) s'implémente comme un **interceptor** qui injecte automatiquement `WHERE userId = currentUser.id` dans les requêtes Prisma quand le rôle ne porte pas ce droit — factorisé une seule fois, appliqué à tous les modules documentaires (Sales, Purchases, Quotations, Returns, Expenses).

**Validation & contrat d'API (voir §17, point C) :** chaque module valide ses entrées avec des DTOs `nestjs-zod` — une classe DTO NestJS unique par endpoint, dont le schéma zod sous-jacent est exporté tel quel dans `packages/types` et consommé directement par `web`/`mobile`. Une seule définition de schéma, pas de duplication zod ↔ class-validator. `@nestjs/swagger` (branché sur les mêmes DTOs) génère la documentation OpenAPI, à partir de laquelle un client typé (`openapi-fetch`) est régénéré en CI pour `web` et `mobile` — toute dérive de contrat entre l'API et les ~200 endpoints casse le build plutôt que de passer inaperçue en production.

**Versionnement de l'API (voir §17, point AA) :** préfixe global `/api/v1` (`app.setGlobalPrefix('api/v1')`) posé dès P1 — coût nul aujourd'hui, indispensable dès qu'une version mobile est en production : une app installée ne se met pas à jour instantanément, et un changement de contrat non versionné casserait les clients existants sans recours.

**Deux comptes distincts chez l'agrégateur de paiement (voir §17, point M) :** le compte de **la plateforme** (utilisé par `BillingModule` pour prélever l'abonnement SaaS de chaque organisation) et le compte **de chaque tenant** (ses propres identifiants API, saisis dans `SettingsModule`, utilisés par `PaymentsModule`/`PosModule` pour encaisser ses propres clients). Ne jamais confondre les deux dans le code : un webhook de paiement d'abonnement ne doit jamais pouvoir être interprété comme un paiement POS, et inversement.

---

## 6. Temps réel — Socket.io

Synchronise le stock et les ventes en direct entre plusieurs caisses/entrepôts.

| Événement | Émis par | Reçu par | Payload |
|---|---|---|---|
| `stock:updated` | `InventoryModule` après vente/achat/transfert/ajustement | Écrans produits + POS de tous les clients de la même organisation connectés au même entrepôt | `{ organizationId, productId, warehouseId, quantity }` |
| `sale:created` | `PosModule` | Dashboard, rapport "aujourd'hui" | `{ organizationId, saleId, warehouseId, grandTotal }` |
| `stock:lowAlert` | `InventoryModule` quand `quantity <= stockAlert` | Notifications globales (rôles avec `reports.quantityAlerts`) | `{ organizationId, productId, quantity, threshold }` |
| `dashboard:refresh` | Job BullMQ planifié ou événement métier | Dashboard ouvert | agrégats recalculés |
| `backup:completed` | `BackupModule` (fin de job) | Écran de sauvegarde | `{ organizationId, filename, size }` |
| `subscription:updated` | `BillingModule` (webhook agrégateur) | Bandeau d'état d'abonnement (essai expirant, paiement échoué, plan changé) | `{ organizationId, status, planId }` |

Namespaces recommandés, systématiquement scopés par organisation pour éviter toute fuite inter-tenant : `/pos` (`room = org:{organizationId}:warehouse:{warehouseId}`), `/dashboard` (`room = org:{organizationId}`), `/notifications` (`room = org:{organizationId}:user:{userId}`). En multi-instance API, utiliser `@socket.io/redis-adapter` sur le même Redis que BullMQ. Le serveur Socket.io vérifie l'appartenance de l'utilisateur à l'organisation de la room à la connexion — jamais seulement côté client.

---

## 7. Files d'attente — BullMQ

| Queue | Jobs | Déclenchée par |
|---|---|---|
| `email-queue` | Facture, devis, paiement, retour, reset mot de passe — envoyés via le SMTP propre à l'organisation | `NotificationsModule` |
| `sms-queue` | Mêmes événements que email, via Twilio | `NotificationsModule` |
| `pdf-queue` | Génération PDF facture/devis/retour/paiement (Puppeteer headless sur templates HTML, brandés au logo/couleurs de l'organisation) | `SalesModule`, `PurchasesModule`, `QuotationsModule`, `ReturnsModule` |
| `excel-queue` | Export Excel de chaque module (produits, ventes, achats, clients…) | tous les modules exposant `export/excel` |
| `backup-queue` | Export de données par organisation, purge des anciens fichiers | `BackupModule`, à la demande |
| `billing-queue` | Génération de la facture périodique par abonnement, relance de paiement, notification d'essai expirant, **vérification du plafond de CA d'essai** (déclenchée après chaque vente d'une organisation encore en essai, hors fenêtre de lancement) | `BillingModule`, `SalesModule`/`PosModule` (déclencheur), planifié (BullMQ repeatable job) pour le reste |

Chaque queue a son propre `Processor` NestJS (`@Processor('email-queue')`), avec retry exponentiel (3 tentatives) et un `QueueEventsListener` pour notifier l'échec via Socket.io à l'utilisateur qui a déclenché l'action. Chaque job transporte un `organizationId` explicite dans son payload — jamais déduit implicitement — pour que le `Processor` charge la bonne configuration (SMTP, branding, devise) sans ambiguïté.

**Topologie d'exécution (voir §17, point Z) :** les processors tournent dans un **process worker dédié** (même image Docker que `api`, entrypoint distinct — ex. `node dist/worker.js`), déployé et scalé indépendamment de l'API. Puppeteer (`pdf-queue`) est trop gourmand en CPU/mémoire pour cohabiter avec le cycle requête/réponse sans dégrader la latence du POS — le parcours le plus sensible du produit.

---

## 8. Cache & sessions — Redis

- **Cache applicatif namespacé par organisation** : clés préfixées `org:{organizationId}:*` (réglages société, permissions par rôle, taux de conversion d'unités) — TTL court (5 min) invalidé explicitement à l'écriture. Le préfixe empêche qu'une clé mal invalidée d'un tenant pollue un autre.
- **Résolution de sous-domaine** : `org:bySubdomain:{subdomain} → organizationId`, TTL plus long (le mapping change rarement), invalidé quand une organisation change de sous-domaine.
- **Rate limiting** : `@nestjs/throttler` avec store Redis sur les endpoints sensibles (`/auth/login`, `/pos/CreatePOS`), clé de quota incluant l'organisation pour qu'un tenant abusif ne pénalise pas les autres.
- **Backend BullMQ** : connexion Redis dédiée (DB index séparé de celle du cache applicatif).
- **Adapter Socket.io** : pub/sub Redis pour la diffusion multi-instance des événements du §6.
- **Blacklist de tokens** : refresh tokens révoqués (déconnexion, désactivation de compte) stockés avec TTL = durée de vie résiduelle du token.

---

## 9. Frontend web (React + Vite)

### Résolution du tenant & thème (avant tout rendu)

Au chargement de l'app (avant même l'écran de login), le sous-domaine courant (`window.location.hostname`) est envoyé à `GET /public/organizations/by-subdomain/:subdomain` — un endpoint **non authentifié** qui ne renvoie qu'un sous-ensemble non sensible (nom, logo, couleur primaire, statut). Ces données peignent l'écran de connexion avant que l'utilisateur ne s'identifie (§18, parcours d'inscription/connexion). Si le sous-domaine ne correspond à aucune organisation, l'app affiche une page dédiée plutôt qu'un écran de login trompeur.

### Routing (TanStack Router)

Arborescence de fichiers dans `apps/web/src/routes/`, reflet direct des domaines fonctionnels :

```
routes/
├─ _authenticated.tsx        # layout + guard (redirige vers /login si non connecté)
│  ├─ dashboard.tsx
│  ├─ pos.tsx                 # écran caisse plein écran (hors layout sidebar)
│  ├─ products/
│  │  ├─ index.tsx
│  │  ├─ new.tsx
│  │  ├─ $productId.tsx
│  │  └─ $productId.edit.tsx
│  ├─ sales/ purchases/ quotations/ sale-returns/ purchase-returns/
│  ├─ transfers/ adjustments/ expenses/
│  ├─ people/ (customers.tsx, suppliers.tsx, users.tsx)
│  ├─ reports/
│  └─ settings/ (brands.tsx, categories.tsx, units.tsx, permissions.tsx, backup.tsx, organization.tsx, billing.tsx…)
├─ login.tsx
├─ signup.tsx                 # inscription d'une nouvelle organisation (public, hors tenant résolu)
├─ forgot-password.tsx
├─ reset-password.$token.tsx
└─ platform-admin/            # servi uniquement sur admin.monapp.com (§17, point P)
   ├─ _platformAuth.tsx        # layout + guard distinct (PlatformAdmin, pas User) + login propre
   ├─ organizations.tsx        # liste, statut d'abonnement, suspension/réactivation (§18.16)
   └─ dashboard.tsx            # MRR, conversions, churn, factures en échec (§18.16)
```

`platform-admin/` est physiquement dans le même bundle `apps/web` (pour éviter de dupliquer `packages/ui`) mais **jamais atteignable** depuis un sous-domaine tenant : le routeur vérifie le `Host` de la requête avant même de résoudre ces routes, et l'auth y repose sur `PlatformAdmin`, jamais sur `User`.

### Site marketing (apps/marketing)

Servi sur `monapp.com`/`www.monapp.com` (§17, point P), déployé indépendamment de l'app tenant :

- **Accueil** : proposition de valeur, capture d'écran du POS, CTA vers l'inscription.
- **Tarifs** : cartes de plans reflétant `Plan` (§4) — mises à jour manuellement en contenu, mais les prix affichés doivent rester cohérents avec ceux réellement facturés (pas de plan "marketing" qui n'existe pas côté `BillingModule`).
- **Fonctionnalités, FAQ, contact** : contenu statique.
- **Inscription** : le CTA renvoie vers `signup.tsx` de `apps/web` (formulaire réel, création de `Organization`) — le site marketing ne duplique pas la logique d'inscription, il n'en est que la vitrine.
- **Choix technique** : React + Vite comme le reste du frontend pour partager `packages/ui`/`packages/config` sans outil supplémentaire ; si le référencement (SEO) devient prioritaire, une bascule vers un framework à rendu statique (ex. Astro) est envisageable sans impact sur les autres apps — décision différée, non structurante.

### État serveur (TanStack Query)

Un hook par ressource, colocalisé dans `features/{domaine}/api/` : `useProducts()`, `useProduct(id)`, `useCreateSale()`, `useStockByWarehouse(warehouseId)`. Invalidation ciblée par `queryKey` après chaque mutation ; les événements Socket.io (`stock:updated`) déclenchent en plus un `queryClient.invalidateQueries(['products', 'stock'])` pour rester cohérent en temps réel sans polling.

### État client (Zustand)

- `cart.store.ts` — panier POS en cours (produits, quantités, remises) avant validation
- `ui.store.ts` — sidebar compacte/large, thème clair/sombre
- `posSession.store.ts` — client et entrepôt sélectionnés sur l'écran caisse

### Composants (shadcn/ui)

Composants shadcn/ui retenus : `DataTable` (TanStack Table) pour les tableaux triables/filtrables avec pagination serveur, `Dialog` pour les modales, `Combobox` pour les sélecteurs avancés, `Sonner` (toasts) + `AlertDialog` pour les confirmations, un composant `<Barcode>` custom (`jsbarcode` ou `react-barcode`) pour l'affichage des codes-barres, `react-to-print` pour le ticket de caisse (impression navigateur — voir §17, point D pour l'impression thermique réelle).

### Douchette code-barres (voir §17, point D)

Une douchette USB se comporte comme un clavier ("keyboard wedge") : elle tape le code très vite puis envoie `Enter`. L'écran `pos.tsx` capte ce pattern via un listener `keydown` global (accumulation de caractères tant que le délai inter-frappe reste sous ~30ms, validation sur `Enter`) plutôt que de dépendre d'un champ de saisie focus — sans quoi le scan ne fonctionne que si le curseur est au bon endroit.

### i18n

`react-i18next`, structure `apps/web/src/locales/{lang}/common.json`, langues prioritaires `fr` + `en` d'abord, extension progressive vers les 14 langues d'origine (§16 Annexes pour la liste).

---

## 10. Application mobile (Expo + React Native)

Une application POS mobile **toujours connectée**, qui consomme la même API REST et le même canal Socket.io que le web — architecture volontairement alignée sur le frontend web pour limiter la duplication de logique. Le choix « toujours connecté » est un **arbitrage assumé**, avec sa conséquence opérationnelle (pas d'encaissement pendant une coupure réseau) — voir §14 et §17, point AE.

- **Résolution du tenant** : pas de sous-domaine sur une app native — l'écran de connexion demande d'abord l'identifiant de l'organisation (ex. "boutique-durand", même valeur que le sous-domaine web), résolu via le même endpoint public que le web (`GET /public/organizations/by-subdomain/:subdomain`) avant d'afficher le formulaire email/mot de passe brandé.
- **Navigation** : `expo-router`, écrans du parcours §18.2 (recherche produit, panier, paiement, reçu imprimable).
- **Scan code-barres** (voir §17, point D) : `expo-camera` (ou `vision-camera-code-scanner`) pour scanner directement avec l'appareil photo.
- **Impression thermique réelle** (voir §17, point D) : `expo-print` ne pilote qu'une boîte de dialogue d'impression/PDF, pas une vraie imprimante de caisse. Pour une impression ESC/POS sur imprimante thermique 58/80mm (Bluetooth ou réseau), prévoir une librairie dédiée (ex. `react-native-thermal-receipt-printer` ou équivalent), avec `expo-print` gardé en repli pour les environnements sans imprimante physique.
- **État serveur** : TanStack Query, mêmes hooks que `apps/web` réutilisés depuis `packages/types` (schémas et client API générés depuis l'OpenAPI) — pas de couche de synchronisation ni de base locale à maintenir.
- **État client** : Zustand, même logique de panier POS que sur web (`cart.store.ts` mutualisé dans `packages/utils` si la logique est extraite).
- **Temps réel** : connexion au même Gateway Socket.io que le web (`stock:updated`, `sale:created`) pour refléter les changements de stock en direct sur tous les terminaux.
- **Design system** : même mécanique de theming runtime qu'en web (§3) — couleur de l'organisation résolue puis appliquée via `nativewind` (Tailwind pour React Native), vert par défaut si le tenant n'a rien personnalisé.
- **Distribution** : build et publication via **EAS** (`eas build`, `eas submit`), intégrés au pipeline CI/CD (§12).

---

## 11. Permissions & RBAC (89 droits)

89 droits nommés, regroupés par domaine :

| Domaine | Droits |
|---|---|
| Utilisateurs & accès | `users.view/edit/delete/create`, `permissions.view/edit/delete/create` |
| Catalogue | `products.view/edit/delete/create/import`, `barcode.view`, `categories.*`, `brands.*`, `units.*`, `currencies.*` |
| Stock | `transfers.*`, `adjustments.*`, `warehouses.*` |
| Ventes | `sales.*`, `paymentSales.*`, `saleReturns.*`, `pos.access` |
| Achats | `purchases.*`, `paymentPurchases.*`, `purchaseReturns.*`, `paymentReturns.*` |
| Devis & tiers | `quotations.*`, `customers.*` (+`import`), `suppliers.*` (+`import`) |
| Système | `expenses.*`, `backup.access`, `settings.system` |
| Organisation & facturation | `organization.branding.edit` (logo/couleurs), `billing.view`, `billing.manage` (changer de plan, gérer le paiement) — jamais accordé par défaut à un rôle non-admin |
| Rapports | `reports.warehouse`, `reports.quantityAlerts`, `reports.profit`, `reports.suppliers`, `reports.customers`, `reports.purchases`, `reports.sales`, `reports.paymentsPurchaseReturns`, `reports.paymentsSaleReturns`, `reports.paymentsPurchases`, `reports.paymentsSales` |
| Transverse | `records.viewAll` — bascule "voir tout" vs "voir mes documents seulement" |

> Cette itération ajoute au catalogue d'origine les droits **`sales.cancel`** et **`purchases.cancel`** (annulation d'un document validé, §18.18) — jamais accordés par défaut à un rôle non-admin, l'annulation restituant du stock et sortant des montants des rapports.

**Catalogue global vs rôles par organisation (voir §17, point A) :** le catalogue des droits (`Permission`) est défini une seule fois, partagé par toutes les organisations. Chaque organisation construit ses propres `Role` à partir de ce catalogue commun — deux tenants peuvent avoir un rôle nommé "Caissier" avec des permissions différentes, sans collision (`@@unique([organizationId, name])`, §4). Le staff plateforme (`PlatformAdmin`) n'utilise pas ce système : son accès est géré séparément par `PlatformAdminModule`.

---

## 12. DevOps, CI/CD & exploitation

Ces pratiques sont intégrées dès la Phase P0, pas en fin de projet.

### 12.1 Conteneurisation

- **`Dockerfile` multi-stage** pour `apps/api` et `apps/web` : étape `deps` (install), `build` (Turborepo build ciblé via `turbo build --filter=api`), `runner` (image finale minimale, utilisateur non-root, `NODE_ENV=production`).
- **`docker-compose.yml`** racine pour le développement local : services `postgres`, `redis`, et en option `api`/`web` en mode watch — permet à toute personne rejoignant le projet de démarrer l'environnement complet en une commande.
- **`apps/mobile`** n'est pas conteneurisé (build géré par EAS, hors Docker).
- **Process worker BullMQ** : même image que `apps/api`, entrypoint distinct (§7, §17 point Z) — déclaré comme service à part entière dans `docker-compose.yml` et dans les déploiements.

### 12.2 Intégration continue (CI)

Pipeline ` .github/workflows/ci.yml` déclenché sur chaque Pull Request :

| Job | Étapes |
|---|---|
| `lint` | `turbo lint` (ESLint + Prettier check) sur tous les workspaces modifiés |
| `typecheck` | `turbo typecheck` (`tsc --noEmit`), y compris génération préalable du client Prisma |
| `test:unit` | `turbo test:unit` — Jest sur les services `api`/`web`, mocks uniquement, aucune base de données ; tests de contrat sur les DTOs `packages/types` |
| `test:integration` | `turbo test:integration` — Jest + Supertest contre une vraie Postgres/Redis de test (service container GitHub Actions ou `docker-compose.test.yml`, §16) ; couvre chaque module NestJS de bout en bout |
| `build` | `turbo build` avec cache distant (Turborepo Remote Cache) pour accélérer les runs suivants |
| `e2e` (optionnel, sur `main`) | Playwright pour les parcours critiques du §18 côté `web` |

Cache Turborepo distant (Vercel Remote Cache ou self-hosté) obligatoire pour garder des CI rapides à mesure que le monorepo grossit.

### 12.3 Déploiement continu (CD)

- **Branches protégées** : `main` (déploie en continu vers `staging`), tags `v*.*.*` (déploie en `prod` après validation manuelle — *manual approval gate* GitHub Actions).
- **Workflows séparés** : `deploy-staging.yml` (auto sur merge `main`), `deploy-prod.yml` (déclenché par tag, avec étape d'approbation).
- **Migrations Prisma en pipeline** : `prisma migrate deploy` exécuté comme étape dédiée avant le redémarrage des instances `api`, jamais `db push` en production.
- **Mobile** : `eas build --profile production` + `eas submit` intégrés en job séparé, déclenché manuellement ou sur tag.
- **Stratégie de rollback** : conserver les 3 dernières images Docker taguées par SHA de commit ; rollback = redéploiement de l'image précédente, pas de rebuild.

### 12.4 Gestion des secrets & configuration

- 12-factor app : toute config sensible via variables d'environnement, jamais commitée (`*.env` dans `.gitignore`, `.env.example` versionné).
- Secrets CI/CD stockés dans les *GitHub Actions secrets* (ou un coffre-fort dédié type Doppler/Vault pour les environnements multiples).
- Les clés tierces modifiables par l'admin (agrégateur de paiement, Twilio, SMTP) restent en base via `SettingsModule` (§5) — jamais réinjectées dans les variables d'environnement au runtime.
- **Chiffrement applicatif des secrets en base (§17, point S)** : toute valeur sensible persistée en base (`SmtpServer.password`, clés API de l'agrégateur propres à chaque tenant) est chiffrée en **AES-256-GCM** avant écriture et déchiffrée à la lecture par un service dédié ; la clé maîtresse (`APP_ENCRYPTION_KEY`) vit exclusivement en variable d'environnement (ou KMS), jamais en base ni dans le dépôt, avec une procédure de rotation documentée. Un dump SQL brut ne doit révéler aucun secret exploitable.

### 12.5 Observabilité

| Axe | Outillage recommandé |
|---|---|
| Logs structurés | `pino` (NestJS) en JSON, niveau configurable par environnement |
| Centralisation des logs | Loki + Grafana, ou service managé équivalent |
| Métriques applicatives | `@willsoto/nestjs-prometheus`, dashboards Grafana (latence API, taille des queues BullMQ, connexions Socket.io actives) |
| Traçage des erreurs | Sentry (`api`, `web` et `mobile`), source maps uploadées en CI |
| Health checks | `HealthModule` (§5) branché sur les probes liveness/readiness de l'orchestrateur |
| Supervision des files | Bull Board (dashboard web des queues BullMQ) exposé en interne uniquement |

### 12.6 Qualité & conventions Git

- **Conventional Commits** (`feat:`, `fix:`, `chore:`…) + `commitlint` en hook `husky` pre-commit/pre-push.
- **Changesets** pour versionner `packages/*` et générer un changelog automatique.
- **Revue obligatoire** avant merge sur `main` (au moins 1 approbation), CI verte requise (branch protection rule).
- **Analyse de dépendances** : Dependabot (mises à jour) + audit de sécurité automatique en CI (`npm audit` / Snyk).

### 12.7 Domaines & certificats multi-tenant

- **DNS wildcard** `*.monapp.com` pointant vers le load balancer/reverse proxy de l'API et du frontend.
- **Certificat SSL wildcard** : le challenge HTTP-01 classique ne fonctionne pas pour un wildcard — utiliser un challenge DNS-01 (Certbot + plugin DNS, ou un proxy managé type Cloudflare qui gère le certificat wildcard automatiquement en amont).
- **Reverse proxy** (Caddy, Traefik ou Nginx) : route toute requête `*.monapp.com` vers `apps/web`/`apps/api`, laisse le middleware `TenancyModule` (§5) résoudre l'organisation à partir du sous-domaine reçu en en-tête `Host`.
- **Domaine personnalisé par client** : hors périmètre de cette itération (§17, point O) — prévoir malgré tout un champ `Organization.customDomain` nullable dès le schéma pour ne pas bloquer son ajout ultérieur (vérification de propriété + CNAME + certificat par domaine, généralement via Let's Encrypt automatisé).
- **Webhooks de l'agrégateur de paiement** : un seul endpoint public par usage (`/webhooks/billing` pour la facturation plateforme, `/webhooks/payments/:organizationId` pour l'encaissement POS de chaque tenant), signature vérifiée systématiquement avant traitement, jamais de confiance sur l'IP source seule.

### 12.8 Sauvegarde & continuité de la plateforme (voir §17, point AB)

La base étant partagée par tous les tenants, sa perte est l'incident maximal du produit — les exports CSV/JSON par tenant (§5 `BackupModule`) sont un service rendu au client, jamais le mécanisme de reprise de la plateforme :

- **Sauvegarde continue** : archivage WAL + snapshots réguliers (PITR — *Point-In-Time Recovery*), pas seulement un `pg_dump` quotidien.
- **Objectifs chiffrés** : RPO ≤ 15 minutes (perte de données maximale tolérée), RTO ≤ 4 heures (durée maximale de restauration) — valeurs par défaut, à valider avec le métier avant la mise en production.
- **Rétention** : 30 jours de fenêtre PITR + un snapshot mensuel conservé 12 mois.
- **Test de restauration obligatoire** : une restauration complète est exécutée et vérifiée sur un environnement jetable **avant la bascule en production** (session S50b, §19), puis à intervalle trimestriel — une sauvegarde jamais restaurée n'est pas une sauvegarde.

---
