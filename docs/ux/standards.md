# Standards UX premium — Ensemb

> Référence issue du blueprint UX. À lire lors des sessions frontend (Blocs C, E, F, G, H, M).

## Dix règles non négociables

1. **Latence perçue.** Tout geste répond en moins de 100 ms (état visuel), toute donnée arrive derrière un skeleton — jamais une page blanche. L’optimistic UI s’applique à l’état client (panier, filtres), jamais au stock : le serveur reste seul juge, et l’interface le montre.
2. **Grammaire des états.** Chaque écran est livré avec ses cinq états : chargement, vide, erreur, partiel, succès. Un état vide est une invitation à agir (CTA + explication), jamais un mur blanc.
3. **Erreurs actionnables.** Une erreur nomme la cause et l’action suivante, dans la langue du commerçant — jamais un code technique brut, jamais une 500 rendue à l’écran. En formulaire : message au champ + résumé accessible en tête.
4. **Hiérarchie destructive.** Toute action irréversible passe par une confirmation qui nomme l’objet et répète le verbe (« Annuler la vente », jamais « OK »). La friction est proportionnelle à l’irréversibilité : raison obligatoire pour une annulation.
5. **Continuité du vocabulaire.** Une action garde le même nom du bouton au toast : « Encaisser » produit « Encaissé ». Le lexique est celui du comptoir — encaisser, réceptionner, solder — jamais celui du système.
6. **Temps réel honnête.** Une donnée poussée (stock, dashboard) affiche sa fraîcheur et signale sa mise à jour d’une pulsation brève. Une reconnexion socket resynchronise silencieusement — jamais de chiffre qui change sans explication possible.
7. **Accessibilité AA, sans exception.** Contraste ≥ 4.5:1 — garanti jusque dans la couleur choisie par le tenant (garde-fou intégré). Focus visible partout, POS pilotable entièrement au clavier, cibles tactiles ≥ 44 px sur mobile.
8. **Deux densités, un système.** Le back-office est dense (tableaux, filtres, raccourcis) ; la caisse est spacieuse (grands corps, grandes cibles, contraste renforcé pour la luminosité d’une boutique). Deux registres, une seule bibliothèque de composants.
9. **Multi-tenant sans couture.** Le thème du tenant est posé en variables CSS avant le premier rendu : jamais de flash de la couleur par défaut chez une organisation personnalisée. Le « succès » reprend la couleur de marque active.
10. **Confiance financière.** Montants en chasse fixe tabulaire, alignés à droite, en XAF sans décimales superflues. Le statut de paiement est toujours dérivé et toujours visible ; aucun montant ne disparaît — on annule, on rembourse, on trace.

## Motifs transverses (tous écrans)

1. **Listes documentaires.** Recherche, filtres et pagination serveur sur toutes les listes ; l’état des filtres vit dans l’URL — une liste filtrée se partage par lien. Colonnes canoniques : référence en chasse fixe, montants alignés à droite, statut en badge, actions révélées au survol.
2. **Documents générés (PDF).** Facture, devis, retour : génération en file (pdf-queue), bouton à états « Génération… » → « Télécharger ». Un échec affiche sa cause et se relance — jamais un lien mort.
3. **Suppression douce.** On archive ou on désactive, on ne détruit pas : toute entité référencée ailleurs affiche ses usages avant désactivation, et un document financier ne disparaît jamais — il s’annule (§18.18).
4. **Session & multi-onglets.** Session expirée → modale de reconnexion qui préserve la saisie en cours ; une déconnexion se propage aux autres onglets ; un compte désactivé perd l’accès à la requête suivante, partout.
5. **Connectivité & reconnexion.** Perte du canal temps réel → bannière discrète « reconnexion… » ; au retour, resynchronisation silencieuse (invalidation des requêtes) sans clignotement ni doublon de notification.
6. **Quotas & lecture seule.** Quota atteint ou abonnement impayé : bandeau persistant avec la cause et le CTA ; la création est bloquée, la consultation reste intacte. Jamais une 403 nue à la place d’une explication commerciale.
7. **Notifications.** Cloche persistante alimentée par le modèle Notification : chaque entrée est datée, marquable lue, et emmène vers une action. Le temps réel diffuse, la base retient.
8. **Références lisibles.** VT-0241, AC-0187, DV-0034 : préfixes par type de document, numérotation continue par organisation, toujours en chasse fixe, toujours cliquables — la référence est le nom propre du document.
9. **Raccourcis clavier.** « ? » ouvre la palette des raccourcis ; le POS vit au clavier (F2 recherche, F9 encaisser, Échap vide la ligne). Les raccourcis sont affichés dans les tooltips des actions concernées.
10. **Session de caisse (option S23b).** Si retenue (recommandation §14) : ouverture avec fond de caisse, ventes rattachées à la session, clôture avec écart calculé et journalisé. L’écart n’est pas une accusation : c’est un chiffre daté, expliqué, signé.
