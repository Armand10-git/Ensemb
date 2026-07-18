# Roadmap technique — Reproduction d'Ensemb 

**Stack cible :** NestJS · TypeScript · Prisma · PostgreSQL · Redis · BullMQ · Socket.io · React · Vite · TailwindCSS · shadcn/ui · TanStack Router · TanStack Query · Zustand · React Native · Expo · Turborepo · Docker · GitHub Actions

> Ce document remplace la version agnostique précédente. La stack étant désormais figée, chaque phase liste les modules NestJS, modèles Prisma, écrans React, files BullMQ, événements Socket.io et standards DevOps (CI/CD, conteneurisation, observabilité) concrets à livrer. Il sert à la fois de **roadmap de projet** et de **fichier de référence technique** (architecture, schéma de données, conventions) à garder ouvert pendant tout le développement.

> **Révision du 16 juillet 2026 (revue sécurité & exploitation)** — décisions ajoutées en §17 : chiffrement des secrets tenant (S), piège RLS/pooling (T), journal d'audit (U), paiements mobile money asynchrones & idempotence des webhooks (V), MFA plateforme (W), génération des références (X), stockage objet (Y), workers BullMQ dédiés (Z), versionnement d'API (AA), continuité/PITR (AB), annulation de document (AC), jalon MVP (AD), mode hors-ligne POS assumé hors périmètre (AE). Les sessions intercalaires S08b, T07b, S15b, S21b, S23b, S30b et S50b (§19) portent leur implémentation.

---


> **Extrait ciblé — Parcours utilisateurs (§18).** Document découpé pour lecture sélective par Claude Code ; la version intégrale fait référence.

## 18. Parcours utilisateurs (User Flows)

Cette section décrit **comment un utilisateur vit réellement chaque processus métier**, étape par étape — c'est la logique fonctionnelle fondamentale du système. Les sections précédentes (modules, schéma, endpoints) sont les *moyens* de faire fonctionner ces parcours, jamais l'inverse : si un parcours ci-dessous est incompatible avec l'architecture décrite plus haut, c'est l'architecture qu'il faut ajuster.

### 18.0 Inscription d'une nouvelle organisation

1. Un visiteur arrive sur la page d'inscription publique (`signup.tsx`, hors sous-domaine résolu) et choisit un identifiant d'organisation (ex. "boutique-durand") — sa disponibilité comme sous-domaine est vérifiée en direct pendant la saisie.
2. Il renseigne le nom de son entreprise et crée son propre compte, qui devient automatiquement l'administrateur de la nouvelle organisation.
3. À la validation, `Organization` + premier `User` + `Role` "Administrateur" (toutes permissions du catalogue global) + `Subscription` en statut `TRIALING` sont créés dans la même transaction. Le calcul de `trialEndsAt` dépend du moment de l'inscription (§17 point R) :
   - **Pendant la fenêtre de lancement** (`now() < PlatformSetting.launchPromoEndsAt`) : `trialEndsAt` est fixé à la fin de la fenêtre de lancement, **sans plafond de chiffre d'affaires** — l'organisation peut traiter n'importe quel volume de ventes sans conversion forcée avant la fin de la promotion.
   - **Après la fenêtre de lancement** : `trialEndsAt = now() + Plan.trialDurationDays` (30 jours par défaut), et le chiffre d'affaires cumulé sera surveillé (`billing-queue`) contre `Plan.trialRevenueCapAmount`.
4. Le visiteur est immédiatement redirigé vers `{subdomain}.monapp.com` déjà connecté — pas d'étape de confirmation email bloquante pour commencer à utiliser l'essai.
5. Un bandeau discret indique le nombre de jours restants avant la fin de l'essai (ou "offre de lancement" pendant la fenêtre), avec un lien direct vers l'écran d'abonnement (18.15).

### 18.1 Connexion & navigation selon les permissions

1. L'utilisateur saisit email + mot de passe sur l'écran de connexion, déjà brandé au logo/couleur de son organisation (résolue par sous-domaine avant l'affichage du formulaire, §9).
2. L'API vérifie les identifiants **et** `isActive` — un compte désactivé est rejeté avec un message explicite, pas une erreur générique.
3. Le token (JWT) et la liste des permissions du rôle sont renvoyés en une seule réponse et stockés côté client (store `auth`).
4. Le menu latéral n'affiche **que** les entrées pour lesquelles l'utilisateur a la permission `*.view` correspondante — pas de lien grisé, l'entrée n'existe simplement pas dans le menu.
5. Si l'utilisateur force une URL vers un écran non autorisé, il atterrit sur une page "Non autorisé" (pas une redirection silencieuse vers le dashboard).
6. À la déconnexion (ou désactivation du compte pendant que la session est active), le token est invalidé côté serveur (blacklist Redis) — l'onglet déjà ouvert perd l'accès à la prochaine requête, pas seulement au prochain rechargement.

### 18.2 Vente au comptoir (POS) — le parcours le plus critique

1. Le caissier ouvre l'écran caisse ; l'entrepôt actif est celui par défaut de sa session (§17 point J).
2. Il ajoute des articles au panier par **recherche texte**, **scan** (douchette USB sur web, caméra sur mobile, §17 point D) ou **sélection par catégorie**.
3. Chaque ajout vérifie côté client le stock affiché (mis à jour en direct via `stock:updated`, §6) pour éviter d'ajouter un article déjà épuisé — mais la vérité finale reste côté serveur à la validation (étape 6).
4. Le caissier ajuste quantités, remise ligne par ligne si besoin ; le total (taxes + remise + frais de port éventuels) se recalcule à chaque changement.
5. Il choisit le client (par défaut "walk-in") et le mode de paiement (espèces, carte ou mobile money) ; en espèces, il saisit le montant reçu et le système calcule la monnaie à rendre.
6. À la validation, le serveur **recalcule le total indépendamment du client** (`pos/calculTotal` côté original, `PosModule` ici), rouvre une transaction verrouillée sur le stock (§17 point B), décrémente `ProductWarehouse.quantity` avec conversion d'unité si l'unité de vente diffère de l'unité de stock, crée la vente + ses lignes + son paiement.
7. Le serveur diffuse `stock:updated` et `sale:created` (§6) — les autres caisses connectées au même entrepôt voient le stock bouger sans recharger la page.
8. Le reçu s'imprime (imprimante thermique en cible, repli PDF, §17 point D) ; le panier se vide, l'écran est prêt pour le client suivant.
9. **Cas d'échec** : si le stock a changé entre l'ajout au panier et la validation (autre caisse plus rapide), le serveur rejette la vente avec un message clair ("stock insuffisant, quantité disponible : X") plutôt qu'une erreur 500 — le caissier ajuste et revalide.
10. **Paiement mobile money — flux asynchrone (§17, point V)** : contrairement aux espèces, la confirmation Orange Money/MTN MoMo n'est pas instantanée (push USSD côté client, délais variables). La vente passe en `AWAITING_PAYMENT` : le stock est déjà réservé (décrémenté sous verrouillage, étape 6), l'écran caisse affiche l'attente de confirmation, et c'est le **webhook** de l'agrégateur — idempotent via `WebhookEvent` — qui bascule la vente en `COMPLETED`. Sans confirmation dans le délai imparti (configurable, ex. 3 minutes), la vente expire automatiquement : stock restitué, message clair au caissier, qui peut relancer le paiement ou encaisser autrement.

### 18.3 Vente classique hors-POS (facture)

1. Un utilisateur avec `sales.create` ouvre "Nouvelle vente", choisit client + entrepôt (pas de valeur par défaut imposée, contrairement au POS).
2. Il ajoute des lignes produit une par une (pas de scan rapide requis, formulaire plus détaillé que le POS), avec taxe et remise éditables par ligne.
3. Le statut de paiement est `UNPAID` à la création (aucun paiement n'est saisi à cette étape, contrairement au POS où le paiement est immédiat).
4. La vente peut être envoyée par email ou SMS au client directement depuis l'écran de détail (files `email-queue`/`sms-queue`, §7).
5. Le paiement est enregistré **séparément**, potentiellement en plusieurs fois (voir 18.5).

### 18.4 Devis → conversion en vente

1. Un commercial crée un devis (mêmes lignes/taxes/remises qu'une vente, mais sans impact sur le stock).
2. Le devis est envoyé au client par email/SMS pour validation.
3. Si le client accepte, l'utilisateur clique "Convertir en vente" : une vente est créée avec les mêmes lignes, **c'est seulement à cette étape que le stock est décrémenté** — le devis en lui-même n'a jamais réservé de stock.
4. Le devis reste consultable (statut "converti"), la vente créée est indépendante et suit son propre cycle de paiement (18.3).

### 18.5 Enregistrement d'un paiement (partiel ou total)

1. Sur une vente/achat/retour déjà créé, l'utilisateur ouvre "Ajouter un paiement".
2. Il saisit un montant (qui peut être inférieur au solde restant), un mode de règlement, et éventuellement une note.
3. Le serveur recalcule `paidAmount` (somme de tous les paiements) et en déduit `paymentStatus` : `UNPAID` (aucun paiement) → `PARTIAL` (paiement partiel) → `PAID` (paiement ≥ montant dû) — **jamais saisi manuellement**, toujours dérivé.
4. Chaque paiement génère sa propre ligne dans l'historique (`PaymentSale`/`PaymentPurchase`/…), consultable indépendamment du document parent.
5. Un reçu de paiement peut être envoyé par email/SMS pour ce règlement précis (pas pour l'ensemble du document).

### 18.6 Retour de vente ou d'achat

1. L'utilisateur ouvre le document d'origine (vente ou achat) et choisit "Créer un retour".
2. Il sélectionne les lignes et quantités à retourner (jamais plus que ce qui a été vendu/acheté à l'origine).
3. À la validation, le stock est ajusté dans le **sens inverse** du document d'origine (un retour de vente réincrémente le stock, un retour d'achat le décrémente) — même mécanisme de verrouillage qu'en 18.2.
4. Le retour a son propre statut de paiement : un remboursement est enregistré comme un paiement sur le retour, suivant exactement le parcours 18.5.

### 18.7 Achat & réception fournisseur

1. Un utilisateur crée un bon de commande (fournisseur, entrepôt, lignes produit avec coût d'achat, éventuellement dans une unité d'achat différente de l'unité de stock).
2. À la validation, le stock de l'entrepôt est **incrémenté** immédiatement : il n'y a pas d'étape "commandé" séparée de "reçu", la validation vaut réception.
3. Le paiement au fournisseur suit le parcours 18.5 (souvent partiel, avec des échéances).

### 18.8 Ajustement de stock

1. Un gestionnaire d'entrepôt ouvre "Ajustement", choisit l'entrepôt et le produit.
2. Il indique le type (`addition` ou `soustraction`) et la quantité, avec une raison en note (perte, casse, inventaire physique…).
3. La quantité de `ProductWarehouse` est modifiée directement, sans document commercial associé (pas de client/fournisseur, pas de taxe) — c'est le mécanisme de correction manuelle du stock.

### 18.9 Transfert entre entrepôts

1. L'utilisateur choisit un entrepôt source, un entrepôt destination, et les lignes produit à transférer.
2. À la validation, la même transaction décrémente l'entrepôt source **et** incrémente l'entrepôt destination — jamais l'un sans l'autre (cohérence atomique, comme en 18.2).
3. Les deux entrepôts reçoivent l'événement `stock:updated` s'ils ont des caisses connectées.

### 18.10 Alerte de stock bas

1. Après toute opération qui diminue le stock (vente, transfert sortant, ajustement négatif), le serveur compare la nouvelle quantité au seuil `stockAlert` du produit.
2. Si le seuil est atteint, l'événement `stock:lowAlert` est émis **et** persisté dans `Notification` (§17 point I) pour les rôles ayant `reports.quantityAlerts`.
3. Un badge de notification apparaît dans l'interface (web et mobile) ; l'utilisateur peut la marquer comme lue.

### 18.11 Gestion des rôles & permissions

1. Un administrateur crée ou édite un rôle, coche/décoche des permissions parmi les ~90 disponibles, regroupées par domaine à l'écran (pas une simple liste plate de 90 cases).
2. Il assigne un ou plusieurs rôles à un utilisateur.
3. Dès la prochaine connexion (ou rafraîchissement de session) de cet utilisateur, son menu et ses accès reflètent immédiatement le nouveau jeu de permissions — sans qu'il ait besoin qu'un admin lui explique quoi que ce soit.
4. Cas particulier `records.viewAll` : un rôle qui ne l'a pas voit les mêmes écrans que les autres, mais les listes (ventes, achats…) ne contiennent que les documents créés par l'utilisateur connecté — la différence est invisible dans le menu, seulement dans les données retournées.

### 18.12 Export des données de l'organisation

1. Un administrateur clique "Exporter mes données" ; le job part en arrière-plan (`backup-queue`, §7) plutôt que de bloquer l'écran — il génère un CSV/JSON limité aux tables de **son** organisation, jamais un dump de la base partagée.
2. Une fois terminé, la liste des exports se met à jour (Socket.io `backup:completed`) sans que l'utilisateur ait à recharger la page.
3. Il peut télécharger ou supprimer un export individuellement ; les anciens sont purgés automatiquement selon la politique de rétention définie.

### 18.13 Génération d'un rapport

1. L'utilisateur choisit un type de rapport (ventes, profit & perte, top produits…) et des filtres (période, entrepôt, client/fournisseur).
2. Le rapport s'affiche à l'écran avec un graphique et un tableau détaillé ; il peut être exporté en Excel (`excel-queue`, §7) sans bloquer l'interface.
3. Les montants affichés doivent toujours être cohérents avec les documents sources, y compris juste après une vente qui vient d'être créée depuis une autre caisse (invalidation du cache Redis sur les événements métier, pas seulement sur un TTL, §8).

### 18.14 Personnalisation de l'organisation (branding)

1. Un administrateur (permission `organization.branding.edit`) ouvre l'écran "Personnalisation", uploade un logo et choisit une couleur primaire via un sélecteur.
2. Un contrôle de contraste (§3) avertit en direct si la couleur choisie est illisible en texte blanc, avec une suggestion de teinte plus foncée.
3. Un aperçu en direct montre le rendu (bouton, en-tête, badge) avant validation — pas seulement un aperçu de la pastille de couleur.
4. À l'enregistrement, tous les clients connectés de l'organisation (web et mobile) reçoivent le nouveau thème sans redéploiement ni rechargement forcé.

### 18.15 Souscription et gestion de l'abonnement

1. Depuis le bandeau d'essai (18.0) ou l'écran "Facturation" (permission `billing.manage`), l'utilisateur choisit un plan (mensuel/annuel) et un mode de paiement (carte, Orange Money, MTN MoMo).
2. Il est redirigé vers la page de paiement de l'agrégateur ; à la confirmation, un webhook signé notifie `BillingModule`, qui active `Subscription` et prolonge `currentPeriodEnd`.
3. Si le paiement échoue ou n'est pas confirmé sous un délai raisonnable, l'abonnement reste en `TRIALING`/`PAST_DUE` et l'utilisateur voit un message explicite, pas un abonnement activé par erreur.
4. À chaque échéance, `billing-queue` régénère une facture et un nouveau lien de paiement, envoyé par email ; sans paiement sous le délai de grâce, l'organisation passe en lecture seule (accès maintenu, création bloquée) plutôt que suspendue brutalement.
5. Dépasser un quota du plan actuel (ex. 6ᵉ entrepôt sur un plan qui en autorise 5) affiche une invite claire à changer de plan, au lieu d'un blocage silencieux ou d'une erreur technique.
6. **Fin d'essai anticipée par le chiffre d'affaires** (hors fenêtre de lancement, §18.0) : après chaque vente, si le CA cumulé de l'organisation depuis le début de son essai dépasse `Plan.trialRevenueCapAmount`, `trialEndsAt` est ramené à l'instant présent et `trialEndedReason = REVENUE_CAP` (§4). L'utilisateur voit un message explicite ("Votre activité dépasse le cadre de l'essai gratuit, merci de choisir un plan pour continuer") plutôt qu'une coupure d'accès sans explication — il garde l'accès en lecture jusqu'à souscription, comme en cas de non-paiement (étape 4).

### 18.16 Tableau de bord & gestion des organisations (staff plateforme)

1. Un membre du staff se connecte sur `admin.monapp.com`, avec ses propres identifiants (`PlatformAdmin`), totalement séparés de ceux de tout tenant — jamais via un sous-domaine tenant.
2. Le tableau de bord affiche en un coup d'œil : MRR courant et son évolution, nombre d'organisations actives/en essai/suspendues, taux de conversion essai→payant sur la période, taux de churn (résiliations), et une liste des comptes à risque (essai expirant sous 3 jours, facture en échec de paiement).
3. Il consulte la liste complète des organisations (statut d'abonnement, plan, date de création, dernière activité) et peut suspendre ou réactiver une organisation en un clic.
4. Une organisation suspendue voit ses utilisateurs bloqués à la connexion avec un message clair, sans que ses données soient supprimées.

### 18.17 Découverte depuis le site marketing

1. Un visiteur arrive sur `monapp.com`, lit la proposition de valeur et la page tarifs, et clique "Essayer gratuitement".
2. Il est envoyé vers `signup.tsx` (18.0) sur l'app tenant — le site marketing ne recueille lui-même aucune donnée de compte, il ne fait que rediriger.
3. Si le visiteur clique "Se connecter" sans connaître son sous-domaine, un formulaire dédié lui demande l'identifiant de son organisation avant de le rediriger vers `{subdomain}.monapp.com/login` (même logique que l'écran mobile, §10).

### 18.18 Annulation d'un document validé

1. Un utilisateur disposant de la permission dédiée (`sales.cancel` — jamais accordée par défaut aux caissiers, §11) ouvre une vente validée et choisit « Annuler ».
2. Une raison est obligatoire ; l'annulation est confirmée par un dialogue explicite — l'action est irréversible.
3. À la validation, le stock est **restitué** sous le même verrouillage optimiste qu'en 18.2, le document passe en statut `CANCELLED`, et l'action est journalisée dans `AuditLog` (acteur, raison, montants).
4. Un document annulé reste consultable (jamais supprimé physiquement) mais sort des rapports de chiffre d'affaires ; un paiement déjà encaissé dessus est régularisé via un retour (18.6) ou une écriture de remboursement explicite — jamais effacé silencieusement.
5. Le même parcours s'applique aux achats (`purchases.cancel`, stock décrémenté à l'annulation) ; un devis, sans impact stock, s'annule sans cette mécanique.

---
