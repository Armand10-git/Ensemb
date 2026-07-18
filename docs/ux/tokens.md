# Design tokens — Ensemb

> Dérivés de la ROADMAP §3. L'échelle verte est le thème par défaut, remplacé au runtime par la couleur du tenant. La sémantique de statut est invariante.

## Couleurs

| Token | Hex | Usage |
|---|---|---|
| green-50 | `#F0FBF4` | Fonds clairs |
| green-100 | `#DCF5E3` | Hover léger |
| green-200 | `#BAEAC8` | Bordures |
| green-400 | `#55C17D` | Primary sombre |
| green-500 | `#2FA75E` | Marque / Primary |
| green-600 | `#1F8A4B` | Hover primary |
| green-700 | `#196F3D` | Actif / pressé |
| green-900 | `#154A2C` | Fonds accentués |
| green-950 | `#09291A` | App bar sombre |
| amber | `#B45309` | Alerte |
| red | `#B91C1C` | Critique |
| sky | `#0369A1` | Information |

## Typographie

| Rôle | Famille · graisse | Corps | Usage |
|---|---|---|---|
| Display | Bricolage Grotesque · 600–700 | 28–40 px | Titres d’écran, chiffres héros (monnaie à rendre) |
| Titre | Bricolage Grotesque · 600 | 17–21 px | Titres de cartes, de sections, de dialogues |
| Corps | Instrument Sans · 400–500 | 14–15 px | Textes courants, formulaires, descriptions |
| Interface | Instrument Sans · 500–600 | 12.5–13.5 px | Boutons, onglets, libellés, menus |
| Données | IBM Plex Mono · 400–600 | 12–13 px | Références (VT-0241), montants, codes-barres, badges |

## Espace, forme, mouvement

| Axe | Règle | Note |
|---|---|---|
| Espacement | Base 4 px — échelle 4 / 8 / 12 / 16 / 24 / 32 / 48 | La densité back-office descend à 8, la caisse monte à 16+ |
| Rayons | 8 px (champs) · 12 px (cartes) · 999 px (badges) | Un seul langage de courbure sur web et mobile |
| Élévation | Niveau 0 (listes) · 1 (cartes) · 2 (surfaces flottantes) | L’ombre encode la superposition, jamais la décoration |
| Mouvement | 150–200 ms, ease-out ; entrée > sortie | prefers-reduced-motion respecté : tout reste utilisable sans animation |
| Iconographie | lucide-react, trait 1.5–2 px, 16–20 px | Toujours accompagnée d’un libellé dans les actions primaires |

## Composants & états obligatoires

| Composant | Rôle | États & règles |
|---|---|---|
| DataTable | Listes documentaires (ventes, achats, stock) | Skeleton de lignes · vide avec CTA · tri + pagination serveur · ligne entière cliquable · sélection multiple |
| Formulaire | Création / édition | Validation zod partagée client-serveur (mêmes messages) · erreurs au champ · brouillon préservé en cas d’échec réseau |
| Bouton | Actions | Repos · survol · actif · chargement (verrouillé) · désactivé expliqué par tooltip — jamais muet |
| Combobox | Client, produit, fournisseur | Recherche asynchrone avec debounce · « Créer « X » » inline · récents en tête |
| Toast (Sonner) | Issues d’actions | 4 s · verbe de l’action au participe (« Encaissé ») · action Annuler quand elle est possible |
| AlertDialog | Confirmations destructives | Nomme l’objet · verbe explicite · champ raison si irréversible · bouton dangereux distinct |
| Badge de statut | PAID / PARTIAL / UNPAID · états de documents | Couleur + libellé (jamais la couleur seule) · PAID = couleur de marque, PARTIAL = ambre, UNPAID = rouge |
| Notification | Alertes persistées | Badge cloche · liste antichronologique · chaque entrée emmène vers une action · marquage lu/non-lu |
| Écran (générique) | Toute route | Livré avec ses 5 états : chargement, vide, erreur, partiel, succès — vérifié à la revue de code |
