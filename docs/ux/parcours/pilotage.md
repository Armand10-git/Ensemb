# Parcours UX — Pilotage & réglages

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [18.13] Dashboard temps réel

*Quatre chiffres qui comptent, une fraîcheur affichée plutôt que supposée, une mise en page qui ne saute jamais.*

**Écran** : dashboard.tsx · **Temps réel** : dashboard:refresh · sale:created · **Cache** : Agrégats Redis · **Cible UX** : Fraîcheur visible

1. **Chargement squelette** — Cartes KPI et graphiques arrivent derrière des skeletons à leur forme finale. *(UI : Skeletons dimensionnés · UX : La mise en page ne saute pas quand les données arrivent)*
2. **KPI hiérarchisés** — CA du jour, ventes, alertes, top produits — quatre chiffres majeurs, pas davantage. *(UI : Cartes KPI + graphiques · UX : Un dashboard premium choisit ; le reste vit dans les rapports)*
3. **Temps réel honnête** — Les ventes entrantes actualisent les agrégats, l’horodatage l’atteste. *(UI : Mention « à l’instant · il y a 2 min » · UX : Une reconnexion resynchronise sans clignotement)*
4. **Filtres mémorisés** — Période et entrepôt conservés pour la session. *(UI : Segmented control de période · UX : Revenir au dashboard, c’est le retrouver comme on l’a laissé)*

**Temps réel** : sale:created · dashboard:refresh — recalcul planifié ou événement métier

## [18.11] Rôles & permissions

*91 droits rendus lisibles par la structure, des effets prévisualisés, une restriction nommée pour ne jamais ressembler à un bug.*

**Écran** : settings/permissions · **Permission** : permissions.edit · **Catalogue** : 91 droits groupés · **Cible UX** : Effets prévisibles

1. **Groupés, pas empilés** — Les droits sont regroupés par domaine, avec « tout cocher » par groupe et compteur. *(UI : Accordéons par domaine · UX : 91 cases à plat sont illisibles — la structure porte le sens)*
2. **Rôles composables** — Un utilisateur cumule plusieurs rôles ; les droits effectifs se prévisualisent avant d’enregistrer. *(UI : Multi-select + aperçu des droits cumulés · UX : On voit l’effet d’un changement avant de le subir)*
3. **Application vivante** — Menu et accès reflètent les nouveaux droits dès la reconnexion ou le rafraîchissement de session. *(UX : L’écran annonce quand les changements prennent effet)*
4. **records.viewAll, invisible et juste** — Sans ce droit : mêmes écrans, données restreintes aux siennes. *(UI : Mention « Vos documents » en tête de liste · UX : La restriction est nommée pour ne pas ressembler à des données manquantes)*

**Cas limites** : Retrait de ses propres droits d’administration → garde-fou : au moins un admin complet par organisation

## [18.14] Personnalisation de la marque

*La couleur du tenant, oui — mais jamais au prix de la lisibilité : le contraste AA se négocie au moment du choix.*

**Écran** : settings/organization · **Permission** : organization.branding.edit · **Garde-fou** : Contraste ≥ 4.5:1 · **Cible UX** : 0 flash du thème par défaut

1. **Logo & couleur** — Dépôt du logo et sélecteur de couleur primaire. *(UI : Color picker + zone de dépôt · UX : Formats et poids acceptés annoncés avant l’upload, pas après l’échec)*
2. **Garde-fou de contraste** — Ratio ≥ 4.5:1 exigé avec du texte blanc ; une teinte plus foncée est suggérée sinon. *(UI : Jauge de contraste en direct · UX : L’outil corrige avec l’utilisateur — il n’inflige pas un refus a posteriori)*
3. **Aperçu réel** — Bouton, en-tête et badge rendus avec la couleur candidate. *(UI : Mini-scène de composants · UX : On prévisualise des composants réels, pas une pastille)*
4. **Propagation instantanée** — Le thème atteint tous les clients connectés, web et mobile, sans redéploiement. *(UX : Variables CSS posées avant le premier rendu — jamais de flash vert par défaut)*

**Cas limites** : Logo trop lourd ou format non supporté → limite affichée en amont, compression proposée

## [18.12] Export des données

*Un traitement long ne prend jamais l’interface en otage : le job part, l’écran vit, la fin s’annonce d’elle-même.*

**Écran** : settings/backup · **Permission** : backup.access · **Temps réel** : backup:completed · **Cible UX** : Écran jamais bloqué

1. **Un clic, un job** — « Exporter mes données » part en arrière-plan ; la ligne apparaît « en cours ». *(UI : Liste d’exports avec états · UX : L’utilisateur peut quitter l’écran — rien n’est perdu)*
2. **Fin annoncée** — La liste se met à jour d’elle-même ; le téléchargement passe par une URL signée. *(UI : Toast + bouton « Télécharger » · UX : La promesse est bornée : les données de son organisation, en CSV/JSON — et l’interface le formule ainsi)*
3. **Cycle de vie visible** — Taille, date, purge automatique annoncée sur chaque export. *(UI : Colonne d’expiration · UX : Ni fichiers éternels ni disparitions surprises — la purge est datée)*

**Cas limites** : Échec du job → ligne en erreur avec cause et bouton « Relancer », notifié aussi par la cloche

**Temps réel** : backup:completed

## [18.15] Abonnement & facturation

*Décider avec ses propres chiffres, payer chez l’agrégateur, revenir dans un état toujours nommé — jamais de coupure muette.*

**Écran** : settings/billing · **Permission** : billing.manage · **Temps réel** : subscription:updated · **Cible UX** : Aucune coupure inexpliquée

1. **Choisir en connaissance** — Plans et quotas juxtaposés à l’usage réel : « 4 / 5 entrepôts ». *(UI : Cartes de plans + jauges d’usage · UX : La décision s’appuie sur sa consommation, pas sur une grille abstraite)*
2. **Paiement délégué, retour maîtrisé** — Redirection vers l’agrégateur (carte, Orange Money, MTN MoMo) ; la confirmation arrive par webhook. *(UI : Écran de retour avec statut vivant · UX : Tant que le webhook n’a pas parlé : « confirmation en cours » — jamais un faux « activé »)*
3. **Échec sans piège** — Paiement non confirmé → statut inchangé, message explicite. *(UI : Bannière d’état d’abonnement · UX : L’erreur donne l’action suivante : réessayer, changer de moyen)*
4. **Échéances douces** — Facture et lien de paiement par email ; sans règlement, passage en lecture seule — pas de coupure brutale. *(UI : Bandeau « lecture seule » avec cause et CTA · UX : La dégradation de service est progressive, expliquée, réversible)*
5. **Quota atteint** — Le 6e entrepôt d’un plan à 5 ouvre une invite de changement de plan. *(UI : Modale comparative des plans · UX : Un plafond commercial n’est jamais rendu comme une erreur technique)*

**Cas limites** : Fin d’essai par plafond de CA → message dédié : « Votre activité dépasse le cadre de l’essai » + accès lecture maintenu

**Temps réel** : subscription:updated — bandeau d’état

## [G1] Réglages : société, reçu POS, SMTP

*Chaque option du reçu se voit sur un ticket d’aperçu ; un SMTP se teste avant d’être enregistré — jamais découvert cassé sur une vraie facture.*

**Écran** : settings/* · **Permission** : settings.system · **Stockage** : En base, par organisation · **Cible UX** : 0 réglage à l’aveugle

1. **Sections claires** — Société (coordonnées, devise, langue), reçu POS, email — trois espaces distincts. *(UI : Navigation par onglets de réglages · UX : Un réglage se trouve là où son effet se produit)*
2. **Le reçu en direct** — Chaque case (afficher le code-barres, la note client, l’adresse…) se reflète sur un ticket d’aperçu. *(UI : Aperçu de ticket 80 mm à droite du formulaire · UX : On règle un reçu en le regardant, pas en l’imaginant)*
3. **SMTP testable** — « Envoyer un email de test » avant d’enregistrer ; le résultat s’affiche avec la cause en cas d’échec. *(UI : Bouton de test + verdict inline · UX : La première vraie facture n’est jamais le premier test)*
4. **Secrets masqués** — Mots de passe et clés affichés masqués, jamais ré-exposés après enregistrement. *(UI : Champs à révélation ponctuelle · UX : Modifier un secret = le remplacer, jamais le relire)*

**Cas limites** : Test SMTP en échec → cause lisible (authentification, port…) et lien vers l’aide

## [G2] Utilisateurs & profil

*On désactive, on ne supprime pas : l’accès se coupe immédiatement, l’historique des documents reste intact.*

**Écran** : people/users · profil · **Permission** : users.create · **Révocation** : Immédiate (blacklist) · **Cible UX** : Désactivation effective à la requête suivante

1. **Créer un compte** — Email unique dans l’organisation, rôles assignés à la création. *(UI : Formulaire + multi-select de rôles · UX : Les droits effectifs du profil se prévisualisent avant l’envoi de l’invitation)*
2. **Désactiver, pas supprimer** — L’accès est coupé immédiatement — session comprise — mais chaque vente garde son auteur. *(UI : Bascule d’état + confirmation · UX : L’histoire financière ne perd jamais ses acteurs)*
3. **Profil personnel** — Avatar, langue, changement de mot de passe avec jauge. *(UI : Page profil sobre · UX : Changer son mot de passe révoque les autres sessions — et le dit)*

**Cas limites** : Désactivation du dernier administrateur → refusée avec explication (garde-fou)

## [G3] Préférences : langue & thème

*fr/en instantané, un mode sombre qui recompose la couleur du tenant — et une préférence qui suit l’utilisateur, pas le navigateur.*

**Écran** : profil / en-tête · **i18n** : react-i18next (fr, en…) · **Thème** : Clair / sombre / système · **Cible UX** : Bascule sans rechargement

1. **Langue vivante** — La bascule fr/en s’applique immédiatement, sans rechargement ni perte d’état. *(UI : Sélecteur dans le profil · UX : Dates, montants et pluriels suivent la locale — pas seulement les libellés)*
2. **Sombre, mais à la marque** — Le mode sombre recompose la couleur du tenant (variante claire sur fond sombre) en préservant le contraste AA. *(UI : Bascule clair / sombre / système · UX : Le thème sombre n’est pas un filtre : c’est une palette recomposée)*
3. **Préférence portée** — Mémorisée par utilisateur, appliquée sur web et mobile. *(UX : On retrouve son environnement d’un appareil à l’autre)*
