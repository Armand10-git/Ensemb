import { z } from 'zod';

/** Regex acceptant un nombre décimal à 3 décimales maximum, non négatif. */
const decimalString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Doit être un nombre décimal positif (ex. "1500" ou "1500.500")');

/** Variante à créer avec le produit. */
export const CreateProductVariantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

export const CreateProductSchema = z.object({
  /** Code de référence interne — unique par org ; majuscules, chiffres, tirets. */
  code: z
    .string()
    .min(1, 'Le code est obligatoire')
    .max(50, 'Le code ne peut pas dépasser 50 caractères'),

  name: z
    .string()
    .min(1, 'Le nom est obligatoire')
    .max(255, 'Le nom ne peut pas dépasser 255 caractères'),

  /** Format du code-barres affiché côté client (ex. "EAN13", "CODE128", "QR"). */
  barcodeType: z.string().max(20).optional(),

  /** Prix d'achat HT — string décimale convertie en Decimal dans le service. */
  cost: decimalString,

  /** Prix de vente HT — string décimale. Une promo peut être < coût (avertissement, non bloquant). */
  price: decimalString,

  categoryId: z.string().uuid('categoryId doit être un UUID valide'),

  brandId: z.string().uuid('brandId doit être un UUID valide').optional(),
  unitId: z.string().uuid('unitId doit être un UUID valide').optional(),
  unitSaleId: z.string().uuid('unitSaleId doit être un UUID valide').optional(),
  unitPurchaseId: z.string().uuid('unitPurchaseId doit être un UUID valide').optional(),

  /**
   * Taux de TVA — string décimale (ex. "0.1925" = 19,25 %).
   * Converti en Decimal dans le service.
   */
  taxRate: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/, 'taxRate doit être un nombre décimal (ex. "0.1925")')
    .optional(),

  taxMethod: z.enum(['percentage', 'fixed']).default('percentage'),

  note: z.string().max(1000).optional(),

  stockAlert: z.number().int().min(0).default(0),

  isVariant: z.boolean().default(false),

  /** Variantes initiales — seulement si isVariant = true. */
  variants: z.array(CreateProductVariantSchema).optional(),
});

export const UpdateProductSchema = CreateProductSchema.partial();

export type CreateProductDto = z.infer<typeof CreateProductSchema>;
export type UpdateProductDto = z.infer<typeof UpdateProductSchema>;
export type CreateProductVariantDto = z.infer<typeof CreateProductVariantSchema>;
