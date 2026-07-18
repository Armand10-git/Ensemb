# Parcours UX — Plateforme

> Spécification d'expérience par parcours. Chaque étape : comportement attendu, composant UI, standard UX.

## [18.16] Console du staff plateforme

*Un accès durci (MFA), un métier lisible en un écran, des urgences triées avant tout — et des suspensions toujours réversibles.*

**Écran** : admin.monapp.com · **Auth** : PlatformAdmin + TOTP · **KPI** : MRR · conversion · churn · **Cible UX** : Décision < 3 clics

1. **Accès durci** — Login dédié, second facteur TOTP obligatoire. *(UI : Saisie 6 chiffres auto-avançante, collage accepté · UX : La friction de sécurité est assumée et fluide)*
2. **Le métier en un écran** — MRR et sa tendance, organisations actives/en essai, conversion, churn, factures en échec. *(UI : Cartes KPI pré-calculées · UX : Agrégats mis en cache — jamais dix secondes d’attente sur des sommes vivantes)*
3. **Les comptes à risque d’abord** — Essais expirant sous 3 jours et paiements en échec, triés en tête avec actions inline. *(UI : Liste priorisée · UX : L’écran ordonne par urgence d’action, pas par ordre alphabétique)*
4. **Suspension réversible** — Suspendre ou réactiver en un clic, confirmation nommant l’organisation ; les données ne sont jamais supprimées. *(UI : AlertDialog + bascule de statut immédiate · UX : Côté tenant : un message clair à la connexion, jamais une erreur générique)*

**Cas limites** : Tentative d’accès par un compte tenant → refus net, aucun indice sur l’existence de la console
