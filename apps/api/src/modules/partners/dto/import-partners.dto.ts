import { z } from 'zod';

/**
 * Schéma de validation d'une ligne CSV importée.
 * Le code est auto-généré — il ne doit jamais figurer dans le fichier importé.
 * Colonnes attendues : name, email, phone, country, city, address
 */
export const ImportRowSchema = z.object({
  name:    z.string().min(1).max(255),
  email:   z.string().email().optional().or(z.literal('')).transform(v => v || undefined),
  phone:   z.string().max(30).optional().or(z.literal('')).transform(v => v || undefined),
  country: z.string().max(255).optional().or(z.literal('')).transform(v => v || undefined),
  city:    z.string().max(255).optional().or(z.literal('')).transform(v => v || undefined),
  address: z.string().max(255).optional().or(z.literal('')).transform(v => v || undefined),
});

export type ImportRowDto = z.infer<typeof ImportRowSchema>;

export interface ImportReport {
  imported: number;
  errors: { line: number; message: string }[];
}

/** Colonnes du modèle CSV téléchargeable depuis l'UI. */
export const CSV_TEMPLATE_HEADERS = 'name,email,phone,country,city,address\n';
