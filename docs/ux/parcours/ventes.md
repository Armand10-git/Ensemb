# Parcours UX — Ventes & devis

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [18.3] Vente classique (facture)

*Plus posée que la caisse : un formulaire détaillé, un paiement découplé, un envoi au client en un geste.*

**Écran** : sales/new · **Permission** : sales.create · **Statut initial** : UNPAID · **Cible UX** : Facture émise < 2 min

1. **Le contexte d’abord** — Client et entrepôt choisis explicitement — aucun défaut imposé, contrairement au POS. *(UI : Deux combobox en tête de formulaire · UX : L’ordre du formulaire suit l’ordre mental : pour qui, depuis où, quoi)*
2. **Lignes détaillées** — Produits ajoutés un à un, taxe et remise éditables par ligne. *(UI : Tableau de lignes éditable inline · UX : HT, taxes et TTC se recalculent à chaque édition, en chasse fixe tabulaire)*
3. **Créée impayée** — Statut UNPAID à la création : la vente et son règlement sont deux moments distincts. *(UI : Badge UNPAID · UX : Le statut est dérivé — l’interface ne propose même pas de le modifier)*
4. **Envoi au client** — Email ou SMS expédiés depuis la fiche, traités en file d’attente. *(UI : Bouton « Envoyer » + confirmation d’expédition · UX : L’asynchrone notifie son issue : succès, ou échec avec relance)*

**Cas limites** : Échec d’envoi email/SMS → notification avec cause (SMTP du tenant) et bouton « Réessayer »

## [18.4] Devis → conversion en vente

*Le devis emprunte les gestes de la vente, sans toucher au stock — jusqu’au moment exact de la conversion.*

**Écran** : quotations/* · **Permission** : quotations.create · **Impact stock** : À la conversion seulement · **Cible UX** : Conversion en 1 clic

1. **Un devis, zéro stock** — Mêmes lignes, taxes et remises qu’une vente ; aucun impact sur les quantités. *(UI : Formulaire identique à la vente · UX : Cohérence des écrans = gestes transférables sans réapprentissage)*
2. **Envoi & suivi** — Expédié par email/SMS ; son état (envoyé, accepté) est lisible d’un coup d’œil. *(UI : Timeline d’état sur la fiche · UX : Chaque document raconte où il en est sans ouvrir son historique)*
3. **Conversion en vente** — « Convertir en vente » reproduit fidèlement les lignes ; c’est ici — et seulement ici — que le stock est décrémenté. *(UI : Bouton primaire sur devis accepté · UX : Le moment de l’impact stock est nommé dans la confirmation)*
4. **Trace conservée** — Le devis passe en « converti » et reste lié à la vente créée. *(UI : Liens croisés devis ↔ vente · UX : Navigation bidirectionnelle entre documents liés, toujours)*

**Cas limites** : Stock devenu insuffisant à la conversion → même dialogue de conflit que la caisse, correction ligne à ligne

## [18.5] Enregistrement d’un paiement

*Le solde sous les yeux, le cas majoritaire en un tap, un statut toujours dérivé — jamais saisi.*

**Écran** : fiche document · **Permission** : paymentSales.create · **Statut** : UNPAID → PARTIAL → PAID · **Cible UX** : Statut exact à tout instant

1. **Depuis le document** — « Ajouter un paiement » s’ouvre sur la vente, l’achat ou le retour concerné. *(UI : Sheet latérale — le document reste visible · UX : Le contexte (solde restant) reste sous les yeux pendant la saisie)*
2. **Montant libre** — Le partiel est un cas normal ; le solde restant est affiché et pré-rempli. *(UI : Champ montant + raccourci « Solder » · UX : Le cas majoritaire tient en un tap, le partiel reste naturel)*
3. **Statut dérivé** — paidAmount recalculé côté serveur, statut déduit automatiquement. *(UI : Badge mis à jour à la validation · UX : Une seule source de vérité — aucun statut saisi à la main)*
4. **Historique par règlement** — Chaque paiement a sa ligne, sa date, son reçu envoyable indépendamment. *(UI : Liste des paiements sur la fiche · UX : Un reçu concerne un règlement précis, pas tout le document)*

**Cas limites** : Montant supérieur au solde → borné à la saisie avec explication, pas rejeté au submit

## [18.6] Retour de vente ou d’achat

*Le retour hérite de son document d’origine : rien à re-saisir, rien à dépasser, un stock inversé sous verrou.*

**Écran** : depuis la fiche d’origine · **Permission** : saleReturns.create · **Impact stock** : Sens inverse de l’origine · **Cible UX** : 0 retour supérieur à l’origine

1. **Depuis l’origine** — « Créer un retour » se lance depuis la vente ou l’achat source. *(UI : Action contextuelle de la fiche · UX : On ne re-saisit jamais ce que le système sait déjà)*
2. **Lignes bornées** — Sélection des lignes et quantités, plafonnées à ce qui a été vendu ou acheté. *(UI : Steppers bornés par ligne · UX : L’interface rend l’erreur impossible plutôt que de la signaler après coup)*
3. **Stock inversé** — Restitution (retour de vente) ou décrément (retour d’achat), sous le même verrouillage que la caisse. *(UI : Résumé d’impact stock avant validation · UX : L’effet de l’action est annoncé avant d’être exécuté)*
4. **Remboursement = paiement** — Le remboursement suit exactement le parcours de paiement standard. *(UI : Même sheet de paiement · UX : Un seul modèle mental pour tous les mouvements d’argent)*

**Cas limites** : Retour partiel déjà effectué → quantités restantes recalculées et affichées comme nouveau plafond
