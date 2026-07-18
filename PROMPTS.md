# Piloter Claude Code session par session — mode d'emploi

## Principe d'économie de tokens

Trois niveaux de contexte, du moins cher au plus cher :

1. **`CLAUDE.md`** (≈ 60 lignes) — chargé automatiquement à chaque session. Il contient les règles
   qui doivent être vraies à chaque instant, et l'index des documents. Rien d'autre.
2. **Lecture ciblée** — le prompt de session cite 2 à 4 fichiers/sections précis ; Claude Code lit
   à la demande. Ne jamais coller le contenu des documents dans le prompt.
3. **Le reste de `docs/`** — n'est jamais lu tant qu'aucune session ne le réclame.

Règles d'hygiène :

- **Une session du plan = une conversation.** Terminer par un commit, puis `/clear` (ou nouvelle
  conversation) avant la session suivante : l'historique d'une session ne doit pas payer pour la suivante.
- Le blueprint HTML (`ensemb-ux-blueprint.html`) est un livrable **pour les humains** — ne jamais le
  donner à lire à Claude Code ; son contenu existe en markdown compact dans `docs/ux/`.
- Demander un **plan avant le code** pour les sessions larges, valider, puis laisser exécuter.
- Si Claude Code relit un même gros fichier plusieurs fois, la section demandée était trop vague :
  préciser le titre exact (`§17 point V`, `[18.2]`, `Bloc E`).

## Gabarit de prompt de session

```
Réalise la session <ID> du plan.

À lire (uniquement) :
- docs/roadmap/04-sessions.md → ligne <ID> (périmètre + critère « Fait quand »)
- <fichier> → section <titre exact>
- <fichier UX si session frontend>

Contraintes : respecte CLAUDE.md. Commence par un plan bref (fichiers touchés,
schéma si migration, tests prévus), attends ma validation, puis implémente.
Termine en démontrant le critère « Fait quand » (commande + résultat).
```

## Exemples prêts à l'emploi

**Session backend (S21 — décrément de stock & verrouillage)**

```
Réalise la session S21.
À lire (uniquement) :
- docs/roadmap/04-sessions.md → Bloc E, ligne S21
- docs/roadmap/02-plan-et-decisions.md → §17 points B et X
- docs/roadmap/03-parcours-metier.md → section 18.2 (étapes 6 à 8)
Contraintes : respecte CLAUDE.md. Plan d'abord. Le critère « Fait quand » est un test
de concurrence : deux ventes simultanées sur le dernier exemplaire, une seule réussit.
```

**Session frontend (S23 — écran POS web)**

```
Réalise la session S23.
À lire (uniquement) :
- docs/roadmap/04-sessions.md → Bloc E, ligne S23
- docs/ux/parcours/caisse.md → [18.2] en entier
- docs/ux/standards.md + docs/ux/tokens.md
Contraintes : respecte CLAUDE.md. Livre les 5 états de l'écran (skeleton, vide,
erreur, attente AWAITING_PAYMENT, succès). Plan d'abord.
```

**Session sécurité (T03 — test d'isolation multi-tenant)**

```
Réalise la session T03.
À lire (uniquement) :
- docs/roadmap/04-sessions.md → Bloc B2, ligne T03
- docs/roadmap/02-plan-et-decisions.md → §17 points M et T, §14 (piège RLS/pooling)
Contraintes : respecte CLAUDE.md. Le test doit explicitement simuler la réutilisation
de connexion du pool (SET LOCAL) et prouver qu'aucune donnée d'un tenant ne fuit.
```

## Ordre d'exécution

Suivre l'ordre des blocs de `docs/roadmap/04-sessions.md` (A → N), sans en sauter :
chaque session suppose les précédentes. Le jalon MVP (fin Bloc E + T01–T07) est le premier
point de recette réel — s'y arrêter pour tester l'application de bout en bout.
