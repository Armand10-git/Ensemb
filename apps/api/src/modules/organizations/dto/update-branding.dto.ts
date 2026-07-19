import { z } from 'zod';

/**
 * DTO de mise à jour du branding d'une organisation.
 * Au moins un des deux champs doit être présent.
 *
 * logoUrl    : URL absolue vers le logo (upload réel reporté à S13).
 * primaryColor : couleur principale en HEX 6 chiffres, ex. "#3B82F6".
 */
export const UpdateBrandingSchema = z
  .object({
    logoUrl: z
      .string()
      .url({ message: 'logoUrl doit être une URL valide' })
      .max(2048, { message: 'logoUrl ne peut pas dépasser 2048 caractères' })
      .optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, {
        message: 'primaryColor doit être un code HEX 6 chiffres (ex. "#3B82F6")',
      })
      .optional(),
  })
  .refine((data) => data.logoUrl !== undefined || data.primaryColor !== undefined, {
    message: 'Au moins un champ (logoUrl ou primaryColor) doit être fourni',
  });

export type UpdateBrandingDto = z.infer<typeof UpdateBrandingSchema>;
