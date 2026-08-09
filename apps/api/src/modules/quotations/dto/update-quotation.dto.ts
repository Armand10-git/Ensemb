import { z } from 'zod';
import { QuotationDetailSchema } from './create-quotation.dto';

/**
 * Regex acceptant un nombre décimal à 3 décimales maximum, non négatif.
 * Ex. : "0", "1500.500" → valides.
 */
const nonNegativeDecimalString = z
  .string()
  .regex(
    /^\d+(\.\d{1,3})?$/,
    'Doit être un nombre décimal non négatif (ex. "0" ou "1500.500")',
  );

/**
 * Mêmes champs que CreateQuotationSchema, tous optionnels — n'est autorisé côté service
 * que si le devis est encore au statut PENDING (§17 point 7 : un document COMPLETED ou
 * CANCELLED est immuable).
 */
export const UpdateQuotationSchema = z.object({
  clientId: z.string().uuid('clientId doit être un UUID valide').optional(),
  warehouseId: z.string().uuid('warehouseId doit être un UUID valide').optional(),
  date: z.string().datetime({ message: 'date doit être une date ISO 8601 valide' }).optional(),
  notes: z.string().max(1000, 'La note ne peut pas dépasser 1000 caractères').optional(),
  taxRate: nonNegativeDecimalString.optional(),
  discount: nonNegativeDecimalString.optional(),
  shipping: nonNegativeDecimalString.optional(),
  details: z
    .array(QuotationDetailSchema)
    .min(1, 'Le devis doit comporter au moins une ligne')
    .optional(),
});

export type UpdateQuotationDto = z.infer<typeof UpdateQuotationSchema>;
