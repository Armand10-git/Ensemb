import { z } from 'zod';

/**
 * Liste noire des sous-domaines réservés à la plateforme (§14).
 * Un tenant ne peut pas revendiquer ces identifiants.
 */
export const RESERVED_SUBDOMAINS = [
  'www', 'api', 'admin', 'app', 'mail', 'blog',
  'static', 'cdn', 'assets', 'auth', 'platform',
] as const;

/**
 * Regex RFC 1123 pour les labels DNS :
 * - 1 à 63 caractères
 * - lettres minuscules, chiffres et tirets
 * - ne commence ni ne termine par un tiret
 */
const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * DTO de création d'une nouvelle organisation.
 * Validation en liste blanche (zod) — le mass assignment depuis le body est interdit.
 */
export const RegisterOrganizationSchema = z.object({
  subdomain: z
    .string()
    .min(1, 'Le sous-domaine est requis.')
    .max(63, 'Le sous-domaine ne peut pas dépasser 63 caractères.')
    .regex(SUBDOMAIN_REGEX, 'Sous-domaine invalide : lettres minuscules, chiffres et tirets uniquement, sans tiret en début ou fin.')
    .refine(
      (val) => !(RESERVED_SUBDOMAINS as readonly string[]).includes(val),
      'Ce sous-domaine n\'est pas disponible.',
    ),
  organizationName: z
    .string()
    .min(1, 'Le nom de l\'organisation est requis.')
    .max(255, 'Le nom de l\'organisation ne peut pas dépasser 255 caractères.'),
  adminFirstname: z
    .string()
    .min(1, 'Le prénom est requis.')
    .max(100, 'Le prénom ne peut pas dépasser 100 caractères.'),
  adminLastname: z
    .string()
    .min(1, 'Le nom est requis.')
    .max(100, 'Le nom ne peut pas dépasser 100 caractères.'),
  adminEmail: z
    .string()
    .email('Adresse e-mail invalide.'),
  adminPassword: z
    .string()
    .min(8, 'Le mot de passe doit contenir au moins 8 caractères.'),
});

export type RegisterOrganizationDto = z.infer<typeof RegisterOrganizationSchema>;
