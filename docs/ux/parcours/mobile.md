# Parcours UX — Application mobile

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [M1] Première ouverture & résolution du tenant

*Pas de sous-domaine sur une app native : un identifiant d’organisation, un branding immédiat, puis plus jamais la question.*

**Écran** : app mobile (Expo) · **Endpoint** : /public/organizations/by-subdomain · **Complément** : §10 · **Cible UX** : 2e lancement : direct au login

1. **L’organisation d’abord** — L’identifiant (même valeur que le sous-domaine web) est demandé avant le login. *(UI : Champ unique avec exemple de format · UX : L’écran explique où trouver son identifiant — dans l’URL web de sa boutique)*
2. **Branding immédiat** — Logo et couleur de l’organisation appliqués avant même le formulaire email / mot de passe. *(UI : Login brandé (nativewind) · UX : On sait qu’on est chez soi avant de saisir quoi que ce soit)*
3. **Mémorisé, pas verrouillé** — L’organisation est retenue pour les lancements suivants, avec « Changer d’organisation » discret. *(UI : Lien secondaire sur l’écran de login · UX : Le cas courant est instantané, le cas rare reste accessible)*

**Cas limites** : Identifiant inconnu → aide au format + lien de contact, jamais un rejet sec

## [M2] POS mobile : scan caméra & impression Bluetooth

*Le scan a un retour physique, l’imprimante s’appaire guidée, et l’absence de réseau est dite en face — jamais un bouton qui tourne à vide.*

**Écran** : POS mobile · **Scan** : expo-camera · **Impression** : ESC/POS Bluetooth + repli PDF · **Connectivité** : En ligne requis (§17 AE)

1. **Permission expliquée** — L’accès caméra est demandé au premier scan, avec la raison affichée avant la boîte système. *(UI : Écran d’explication → permission · UX : Une permission surgie sans contexte est un refus garanti)*
2. **Scan avec retour physique** — Visée plein écran, vibration + bip à chaque lecture, article ajouté sans quitter la visée. *(UI : Caméra plein écran + retour haptique · UX : On enchaîne les scans sans regarder l’écran — le retour est tactile et sonore)*
3. **Panier tactile** — Mêmes règles que le web : stock en direct, cibles ≥ 44 px, monnaie à rendre en très grand. *(UI : Composants partagés, registre tactile · UX : Un seul modèle mental caisse, deux surfaces)*
4. **Impression appairée** — Imprimante thermique Bluetooth appairée par un assistant ; sans imprimante, repli PDF proposé immédiatement. *(UI : Assistant d’appairage + repli expo-print · UX : Le repli est un choix visible, pas un échec silencieux)*
5. **Connectivité en face** — Hors réseau, une bannière l’annonce et l’encaissement est désactivé avec explication — arbitrage assumé de cette itération. *(UI : Bannière de connectivité persistante · UX : Dire « impossible hors connexion » vaut mieux qu’un spinner infini — la limite est nommée (§17, point AE))*

**Cas limites** : Lecture d’un code inconnu → proposition de créer le produit ou de chercher manuellement — Échec d’impression Bluetooth → relance + repli PDF en un tap

**Temps réel** : stock:updated · sale:created — mêmes canaux que le web
