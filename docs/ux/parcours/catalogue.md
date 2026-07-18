# Parcours UX — Catalogue & référentiels

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [C1] Créer un produit

*Publier vite, enrichir ensuite : l’essentiel d’abord, la conversion d’unités en français, un code-barres vérifiable à l’écran.*

**Écran** : products/new · **Permission** : products.create · **Complément** : Hors §18 — couverture écran · **Cible UX** : Produit vendable < 45 s

1. **Fiche progressive** — Les champs essentiels d’abord — nom, catégorie, prix, coût ; taxe, seuil d’alerte et variantes en sections repliées. *(UI : Formulaire sectionné, essentiel déplié · UX : On peut vendre un produit incomplet ; on ne bloque jamais sur l’accessoire)*
2. **Unités cohérentes** — Unité de stock, de vente et d’achat liées ; la conversion s’affiche en phrase : « 1 carton = 12 pièces ». *(UI : Selects liés + phrase de vérification · UX : La conversion se lit en français, jamais en opérateur mathématique)*
3. **Code-barres** — Saisi ou généré, avec un aperçu rendu tel qu’il sera imprimé. *(UI : Composant Barcode en direct · UX : Un code-barres se vérifie à l’écran avant de gâcher une planche d’étiquettes)*
4. **Image maîtrisée** — Dépôt avec redimensionnement automatique côté serveur. *(UI : Dropzone + aperçu · UX : Formats et poids annoncés avant l’upload)*
5. **Variantes sans doublon** — Variantes activables ; leurs quantités se gèrent au stock par entrepôt — une seule source de vérité. *(UI : Liste de variantes · UX : Aucun compteur de stock sur la fiche : le stock vit là où il se corrige)*

**Cas limites** : Code produit déjà utilisé → suggestion du prochain code libre — Code d’un produit supprimé → réutilisable (index partiel), l’historique reste consultable

## [C2] Étiquettes code-barres

*De la liste des produits à la planche imprimée, avec un aperçu exact — le papier gâché est le bug le plus visible d’un ERP.*

**Écran** : products (sélection) · **Permission** : barcode.view · **Complément** : Hors §18 · **Cible UX** : Aperçu = impression, au millimètre

1. **Sélection multiple** — Produits cochés depuis la liste, quantité d’étiquettes par produit. *(UI : Sélection de lignes + steppers · UX : La quantité par défaut suit le stock — modifiable en un geste)*
2. **Format de papier** — Choix du gabarit de planche, aperçu exact de la mise en page. *(UI : Presets de formats + aperçu WYSIWYG · UX : Ce qui s’affiche est ce qui s’imprime — aucune surprise à la découpe)*
3. **Impression** — Impression navigateur, marges verrouillées par le gabarit. *(UI : react-to-print · UX : Un test d’une seule planche est proposé avant les grandes séries)*

**Cas limites** : Produit sans code-barres dans la sélection → signalé avec lien direct vers sa fiche

## [C3] Import CSV (clients, fournisseurs, produits)

*Un import premium ne devine rien et ne prend personne en otage : modèle fourni, mapping assisté, erreurs ligne à ligne.*

**Écran** : people / products · **Permission** : customers.import · **File** : excel-queue · **Cible UX** : Import partiel toujours possible

1. **Le modèle d’abord** — Le CSV modèle se télécharge avant tout — colonnes, formats et exemples inclus. *(UI : Bouton « Télécharger le modèle » · UX : On ne devine jamais les colonnes attendues)*
2. **Mapping assisté** — Colonnes détectées, correspondances proposées, ajustables champ par champ. *(UI : Table de correspondance avec aperçu des 3 premières lignes · UX : L’utilisateur valide une interprétation, il ne la construit pas)*
3. **Validation ligne à ligne** — Les erreurs sont listées par ligne et par cause ; les lignes valides s’importent quand même. *(UI : Rapport de validation filtrable · UX : 200 lignes justes ne sont pas otages de 3 lignes fausses)*
4. **Rapport final** — Créés, ignorés (doublons), en erreur — avec export des lignes rejetées pour correction. *(UI : Synthèse chiffrée + export des rejets · UX : Le travail restant sort de l’outil dans un format ré-importable)*

**Cas limites** : Fichier trop volumineux → limite annoncée, découpage suggéré — Encodage inattendu → détection et correction proposée, jamais de caractères corrompus importés en silence

## [C4] Export Excel d’un module

*« Exporter ce que je vois » : les filtres courants s’appliquent, le fichier se prépare en file, l’écran reste libre.*

**Écran** : toutes les listes · **File** : excel-queue · **Complément** : Hors §18 · **Cible UX** : Filtres respectés à l’identique

1. **Depuis la liste filtrée** — L’export reprend exactement les filtres et la période affichés. *(UI : Action « Exporter » dans la barre de liste · UX : Le principe est énoncé dans la confirmation : « Exporter les 143 lignes filtrées »)*
2. **Préparation en file** — Le job part en arrière-plan, le bouton passe à l’état « Préparation… ». *(UI : Bouton à états · UX : Aucun blocage d’écran, même sur les gros volumes)*
3. **Livraison** — Toast avec « Télécharger » à la fin ; échec = cause + relance. *(UI : Toast Sonner avec action · UX : L’issue d’un traitement asynchrone est toujours notifiée)*

**Cas limites** : Export vide (filtres trop restrictifs) → prévenu avant de lancer le job

## [C5] Référentiels : catégories, marques, unités, devises, entrepôts

*Des CRUD volontairement légers, créables depuis n’importe quel formulaire, et qu’on ne supprime jamais à l’aveugle.*

**Écran** : settings/* · **Permission** : categories.* · units.* … · **Complément** : Hors §18 · **Cible UX** : Création inline en < 5 s

1. **Édition sur place** — Listes simples, création et édition en panneau latéral — pas de page dédiée pour trois champs. *(UI : Sheet latérale + liste · UX : Le coût d’un référentiel doit être proportionnel à sa taille)*
2. **Création inline partout** — Une catégorie ou une marque se crée depuis le combobox d’une fiche produit : « Créer « Boissons » ». *(UI : Combobox avec création rapide · UX : On ne quitte jamais un formulaire pour en remplir un autre)*
3. **Unités vérifiables** — Hiérarchie base/dérivée avec phrase de test : « 1 carton = 12 pièces » recalculée en direct. *(UI : Aperçu de conversion · UX : Une unité mal définie fausse tous les stocks — la vérification est immédiate)*
4. **Suppression protégée** — Un référentiel utilisé ne se supprime pas : il se désactive, avec le nombre d’usages affiché. *(UI : Dialogue « Utilisé par 34 produits » · UX : On n’orpheline jamais des données financières pour nettoyer une liste)*

**Cas limites** : Suppression d’une unité de base ayant des dérivées → refus expliqué avec la liste des dérivées
