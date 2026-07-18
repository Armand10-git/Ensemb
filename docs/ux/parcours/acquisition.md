# Parcours UX — Acquisition & accès

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [18.17] Découverte depuis le site vitrine

*Le site marketing éclaire, rassure et redirige — il ne gère jamais de compte.*

**Écran** : monapp.com · **Persona** : Visiteur · **Permission** : — · **Cible UX** : Inscription < 3 min depuis l’accueil

1. **Proposition de valeur immédiate** — Le héros formule le bénéfice côté commerçant — « Encaissez, suivez votre stock, partout » — avec une capture réelle du POS. *(UI : Hero + capture produit · UX : La promesse parle métier, jamais technique)*
2. **Tarifs sans ambiguïté** — Les cartes de plans reflètent exactement les plans facturés, en XAF, avec bascule mensuel/annuel. *(UI : Cartes de plans + toggle · UX : Cohérence stricte vitrine ↔ facturation réelle)*
3. **Essai en un clic** — « Essayer gratuitement » mène directement au formulaire d’inscription de l’application. *(UI : CTA primaire persistant · UX : Un seul CTA primaire par écran)*
4. **Retrouver son espace** — « Se connecter » demande l’identifiant d’organisation puis redirige vers le bon sous-domaine. *(UI : Champ unique + validation · UX : Identifiant inconnu → aide au format, pas un rejet sec)*

**Cas limites** : Identifiant d’organisation inconnu → message doux avec rappel du format et lien de contact

## [18.0] Inscription d’une organisation

*De visiteur à administrateur d’un espace opérationnel, en moins d’une minute, sans étape morte.*

**Écran** : signup.tsx · **Persona** : Visiteur → Admin · **Permission** : — · **Cible UX** : Espace utilisable < 60 s

1. **Identifiant d’organisation** — Saisie avec le suffixe .monapp.com affiché ; disponibilité vérifiée pendant la frappe (debounce 300 ms). *(UI : Champ à validation asynchrone · UX : Verdict inline + suggestions — jamais découvert au submit)*
2. **Entreprise & compte admin** — Nom de l’entreprise, email, mot de passe avec jauge de robustesse — cinq champs, pas un de plus. *(UI : Formulaire une colonne · UX : Aucune donnée non indispensable à l’essai n’est demandée)*
3. **Création transactionnelle** — « Créer mon espace » : organisation, admin, rôle et essai créés dans la même transaction. *(UI : Bouton à états (repos / chargement / succès) · UX : Verrouillé pendant l’appel ; échec = ré-essai sans perte de saisie)*
4. **Atterrissage connecté** — Redirection sur le sous-domaine, déjà authentifié, sans confirmation email bloquante — accueil par une checklist : créer un produit, un entrepôt, une première vente. *(UI : Dashboard + checklist d’onboarding · UX : L’état vide est un plan d’action, pas un écran mort)*
5. **Bandeau d’essai** — Jours restants (ou « offre de lancement »), avec lien direct vers l’abonnement. *(UI : Bannière fine sous l’en-tête · UX : Persistante mais jamais modale)*

**Cas limites** : Sous-domaine réservé (www, admin…) → refus expliqué + alternatives proposées — Échec en cours de transaction → aucune organisation à moitié créée, un seul message clair

## [18.1] Connexion & navigation par permissions

*L’interface d’un utilisateur est exactement l’ensemble de ses droits — rien de grisé, rien de caché à moitié.*

**Écran** : login.tsx · **Persona** : Tous rôles · **Temps réel** : Révocation immédiate · **Cible UX** : 0 flash de contenu interdit

1. **Écran aux couleurs du tenant** — Logo et couleur résolus par sous-domaine avant l’affichage du formulaire. *(UI : Skeleton du logo pendant la résolution · UX : Sous-domaine inconnu → page dédiée, jamais un faux login)*
2. **Identifiants** — Les erreurs sont différenciées : compte désactivé ≠ identifiants invalides. *(UI : Champ mot de passe avec afficher/masquer · UX : Le message dit quoi faire, pas seulement ce qui a échoué)*
3. **Une réponse, tout le contexte** — Token et liste de permissions arrivent ensemble ; l’application se construit en une transition. *(UI : Transition unique vers l’app · UX : Le menu est prêt avant le premier rendu — rien n’apparaît puis disparaît)*
4. **Le menu, ce sont les droits** — Une entrée sans permission n’existe pas — pas de lien grisé. *(UI : Sidebar générée par les permissions *.view · UX : URL forcée → page « Non autorisé » qui nomme le droit manquant)*
5. **Révocation vivante** — Déconnexion ou désactivation : le token est révoqué immédiatement, l’onglet ouvert perd l’accès à la requête suivante. *(UI : Modale de reconnexion si la session tombe · UX : Le travail en cours (panier, brouillon) est préservé côté client)*

**Cas limites** : Compte désactivé → « Votre compte a été désactivé — contactez votre administrateur »

## [A3] Mot de passe oublié

*Honnête sans être bavard : la réponse ne révèle jamais si un compte existe, le lien expire, les sessions se révoquent.*

**Écran** : forgot-password · reset-password · **File** : email-queue · **Sécurité** : Anti-énumération · **Cible UX** : Retour en session < 2 min

1. **Demande neutre** — « Si un compte existe pour cette adresse, un email vient d’être envoyé » — même réponse dans tous les cas. *(UI : Confirmation unique · UX : On n’offre pas la liste des comptes à qui teste des adresses)*
2. **Lien borné** — Lien à durée limitée, usage unique ; expiré = message clair et nouvelle demande en un clic. *(UI : Page de réinitialisation dédiée · UX : Un lien mort explique et relance — il ne laisse pas dans l’impasse)*
3. **Nouveau mot de passe** — Jauge de robustesse, confirmation, puis connexion automatique. *(UI : Deux champs + jauge · UX : La réussite ramène directement au travail, sans re-login)*
4. **Sessions purgées** — Toutes les sessions existantes sont révoquées au changement. *(UX : Reprendre la main sur son compte signifie en exclure les autres)*
