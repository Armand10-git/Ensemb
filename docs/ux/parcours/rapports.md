# Parcours UX — Rapports

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [R1] Consulter un rapport

*Des presets qui couvrent l’essentiel, des chiffres qui se vérifient d’un clic — un rapport premium est traçable jusqu’au document source.*

**Écran** : reports/* · **Permission** : reports.* · **Cache** : Redis, invalidé sur événement · **Cible UX** : Chiffre → document source en 1 clic

1. **Les filtres d’abord** — Période, entrepôt, tiers — avec presets : aujourd’hui, 7 jours, ce mois, mois dernier. *(UI : Barre de filtres + segmented control · UX : Les presets couvrent 90 % des besoins ; le sur-mesure reste à un clic)*
2. **Tableau et graphique, même vérité** — Les deux vues obéissent aux mêmes filtres, en permanence. *(UI : DataTable + Recharts synchronisés · UX : Un chiffre du graphique se retrouve à l’identique dans le tableau)*
3. **Traçabilité** — Chaque agrégat s’ouvre sur la liste des documents qui le composent. *(UI : Lignes cliquables → liste pré-filtrée · UX : La confiance dans un rapport naît de sa vérifiabilité)*
4. **Export fidèle** — Excel ou PDF, avec les mêmes filtres que l’écran. *(UI : Action d’export (voir parcours C4) · UX : Le fichier partagé raconte exactement ce que l’écran montrait)*

**Cas limites** : Période sans données → état vide qui rappelle les filtres actifs et propose de les élargir

## [R2] Rapport du jour & profit / perte

*Le « jour » d’un commerçant est celui de sa boutique : fuseau de l’organisation, jamais celui du navigateur — et une fraîcheur affichée.*

**Écran** : reports/daily · reports/profit · **Permission** : reports.profit · **Fuseau** : Setting.timezone (UTC stocké) · **Cible UX** : Jamais un jour décalé

1. **La journée, la vraie** — Bornes du jour calculées dans le fuseau de l’organisation — un utilisateur en déplacement voit la même journée que la boutique. *(UI : En-tête datée avec fuseau explicite · UX : Les dates sont stockées en UTC, affichées locales — la règle est invisible mais infaillible)*
2. **Profit & perte par période** — Revenus, coûts, marge — avec la même traçabilité vers les documents que tout rapport. *(UI : Cartes de synthèse + détail · UX : La marge n’est jamais un chiffre orphelin : elle s’explique ligne à ligne)*
3. **Fraîcheur assumée** — Agrégats en cache, invalidés sur événement métier ; l’horodatage du calcul est affiché. *(UI : Mention « calculé il y a 3 min » · UX : Un chiffre financier daté vaut mieux qu’un chiffre supposé instantané)*

**Temps réel** : dashboard:refresh — recalcul sur événement métier
