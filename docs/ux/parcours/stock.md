# Parcours UX — Stock & achats

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [18.7] Achat & réception fournisseur

*Valider, c’est réceptionner : la règle est simple, l’interface la dit, la conversion d’unités s’affiche en clair.*

**Écran** : purchases/new · **Permission** : purchases.create · **Impact stock** : Incrément à la validation · **Cible UX** : Réception immédiate, lisible

1. **Bon de commande** — Fournisseur, entrepôt, lignes au coût d’achat — éventuellement dans une unité d’achat différente de l’unité de stock. *(UI : Formulaire type vente, colonne coût · UX : La conversion (1 carton = 12 pièces) est affichée sur la ligne, jamais implicite)*
2. **Validation = réception** — Le stock de l’entrepôt est incrémenté immédiatement — pas d’état « commandé » séparé. *(UI : Confirmation nommant l’entrepôt · UX : La règle métier est énoncée dans l’interface, pas supposée connue)*
3. **Paiement échelonné** — Le solde fournisseur se règle en plusieurs fois via le parcours de paiement. *(UI : Badge PARTIAL + reste-à-payer en liste · UX : Le reste-à-payer se lit depuis la liste, sans ouvrir la fiche)*

**Cas limites** : Coût saisi à zéro → avertissement non bloquant (cas légitime d’un don), demande de confirmation

**Temps réel** : stock:updated — entrepôt de réception

## [18.8] Ajustement de stock

*L’outil de correction : volontairement plus simple qu’un document commercial, jamais sans cause.*

**Écran** : adjustments/new · **Permission** : adjustments.create · **Trace** : Motif obligatoire · **Cible UX** : Correction tracée < 30 s

1. **Cadre minimal** — Entrepôt, produit, sens (ajout ou retrait), quantité — rien d’autre. *(UI : Formulaire court, une colonne · UX : Un outil de correction se doit d’être plus rapide que l’erreur qu’il répare)*
2. **La raison est requise** — Perte, casse, inventaire physique… motif choisi + note libre. *(UI : Select de motifs + note · UX : Un mouvement de stock sans cause est un trou dans la confiance)*
3. **Effet immédiat, diffusé** — Quantité corrigée, événement émis vers les caisses connectées. *(UI : Toast avec la nouvelle quantité · UX : Les autres postes voient la correction sans recharger)*

**Cas limites** : Retrait supérieur au stock → borné avec affichage du disponible (sauf règle de stock négatif activée)

**Temps réel** : stock:updated — entrepôt corrigé

## [18.9] Transfert entre entrepôts

*Tout ou rien : la source et la destination bougent ensemble, ou aucune des deux — et l’interface le promet.*

**Écran** : transfers/new · **Permission** : transfers.create · **Garantie** : Transaction atomique · **Cible UX** : Direction du flux évidente

1. **Source → destination** — Deux entrepôts et les lignes à transférer, le sens du flux visualisé. *(UI : Sélecteurs face à face, flèche directionnelle · UX : La direction est graphique, pas seulement textuelle)*
2. **Tout ou rien** — Décrément de la source et incrément de la destination dans la même transaction. *(UI : Récapitulatif double avant validation · UX : En cas d’échec, rien n’a bougé — et le message le dit explicitement)*
3. **Diffusion double** — Les deux entrepôts reçoivent l’événement de mise à jour. *(UX : Les équipes des deux sites voient le même état au même instant)*

**Cas limites** : Échec sur l’entrepôt destination → transfert intégralement annulé, aucune quantité orpheline

**Temps réel** : stock:updated — source et destination

## [18.10] Alerte de stock bas

*Née de l’événement métier, jamais perdue, toujours actionnable — une alerte qui n’emmène nulle part est du bruit.*

**Écran** : notifications · **Permission** : reports.quantityAlerts · **Temps réel** : stock:lowAlert · **Cible UX** : 0 alerte perdue

1. **Détection au fil de l’eau** — Chaque baisse de stock compare la nouvelle quantité au seuil du produit. *(UX : L’alerte naît de l’opération, pas d’un traitement nocturne)*
2. **Émise et persistée** — Diffusée en direct et enregistrée : un destinataire hors ligne la retrouve à sa connexion. *(UI : Badge cloche incrémenté · UX : Le temps réel n’est jamais la seule mémoire du système)*
3. **Actionnable** — L’alerte ouvre le produit, entrepôt pré-filtré, avec « Créer un achat » à portée. *(UI : Notification cliquable → action directe · UX : Chaque notification propose l’étape suivante)*

**Temps réel** : stock:lowAlert — rôles disposant de reports.quantityAlerts
