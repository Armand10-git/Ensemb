# Parcours UX — Caisse (POS)

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [18.2] Vente au comptoir — le parcours critique

*Une caisse premium se juge en secondes : trois voies d’ajout, une vérité serveur, une attente mobile money toujours narrée.*

**Écran** : pos.tsx / mobile · **Permission** : pos.access · **Temps réel** : stock:updated · sale:created · **Cible UX** : Encaissement espèces < 15 s

1. **Caisse plein écran** — Hors sidebar, entrepôt actif affiché en permanence, raccourcis visibles (F2 recherche · F9 encaisser). *(UI : Layout dédié, registres desktop et tactile · UX : Grands corps, cibles ≥ 44 px, contraste renforcé pour la boutique)*
2. **Trois voies vers le panier** — Recherche instantanée (< 150 ms), scan douchette capté globalement, grille par catégories. *(UI : Listener « keyboard wedge » + combobox + grille · UX : Le scan fonctionne même sans champ focalisé — contrat de base d’une caisse)*
3. **Panier vivant** — Quantités, remise par ligne, total recalculé à chaque geste ; stock affiché en direct. *(UI : Steppers + badge stock branché sur stock:updated · UX : Mise à jour temps réel signalée d’une pulsation — jamais un chiffre qui change en silence)*
4. **Rupture anticipée** — Un article épuisé se grise dans la grille avant même la tentative d’ajout. *(UI : État désactivé + tooltip « épuisé sur cet entrepôt » · UX : On prévient au moment de l’intention, pas au moment de l’échec)*
5. **Client & règlement** — Client « walk-in » par défaut ; en espèces, pavé numérique et monnaie à rendre en très grand corps. *(UI : Combobox client + pavé numérique · UX : La monnaie à rendre est l’information n°1 — elle domine l’écran)*
6. **Validation, vérité serveur** — Total recalculé côté serveur, stock décrémenté sous verrouillage optimiste. *(UI : « Encaisser » à états, ≤ 1 s perçu · UX : Optimistic UI interdit sur le stock — le serveur est seul juge)*
7. **Mobile money : l’attente est un écran** — AWAITING_PAYMENT : compte à rebours de 3 min, statut du push USSD, actions « Renvoyer la demande · Autre moyen · Annuler ». *(UI : Écran d’attente dédié — pas une modale-spinner · UX : Une attente asynchrone non narrée est une caisse bloquée : ici chaque seconde s’explique)*
8. **Reçu & remise à zéro** — Impression thermique lancée, panier vidé, focus revenu sur la recherche — prêt pour le client suivant sans un clic. *(UI : Toast « Vente VT-0241 encaissée » · UX : La fin d’une vente est le début de la suivante)*

**Cas limites** : Conflit de stock à la validation → « Stock insuffisant — disponible : X » + correction de la ligne en un tap — Paiement mobile money expiré → stock restitué, message explicite, panier intact pour ré-encaisser — Imprimante indisponible → repli PDF proposé immédiatement

**Temps réel** : stock:updated — toutes les caisses du même entrepôt · sale:created — dashboard et rapport du jour

## [18.18] Annulation d’un document validé

*On n’efface jamais une trace financière : on l’annule, on restitue, on documente.*

**Écran** : sales/$id · **Permission** : sales.cancel · **Trace** : AuditLog · **Cible UX** : 0 annulation sans raison tracée

1. **Action gardée** — « Annuler la vente » n’apparaît qu’avec la permission dédiée — jamais aux caissiers par défaut. *(UI : Action secondaire en zone dangereuse de la fiche · UX : Le destructif ne cohabite pas avec les actions courantes)*
2. **Friction proportionnelle** — Raison obligatoire, dialogue nommant l’objet : « Annuler la vente VT-0241 ? ». *(UI : AlertDialog + champ raison requis · UX : Le bouton répète le verbe — « Annuler la vente », jamais « OK »)*
3. **Restitution garantie** — Stock restitué sous verrouillage, document basculé en CANCELLED, montants sortis des rapports. *(UI : Badge de statut + montants barrés · UX : Le document reste consultable — rien ne disparaît)*
4. **Trace complète** — Acteur, raison et montants journalisés ; la fiche affiche « Annulée par… le… ». *(UI : Encart d’audit sur la fiche · UX : La confiance financière naît de la transparence de l’historique)*
5. **Régularisation explicite** — Un paiement déjà encaissé passe par un retour ou un remboursement tracé. *(UI : Lien direct « Créer le remboursement » · UX : Jamais d’argent effacé silencieusement)*

**Cas limites** : Annulation concurrente d’une vente déjà annulée → état rafraîchi + message, pas d’erreur technique
