/** TTL du cache Redis pour le mapping sous-domaine → organizationId. */
export const SUBDOMAIN_CACHE_TTL_SECONDS = 3600;

/** Préfixe de clé Redis pour la résolution de sous-domaine. */
export const SUBDOMAIN_CACHE_KEY_PREFIX = 'org:bySubdomain:';

/** Regex de validation d'un sous-domaine (RFC 1123 simplifié). */
export const SUBDOMAIN_REGEX = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;
