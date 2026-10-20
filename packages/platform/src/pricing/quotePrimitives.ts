import { z } from "zod";

/** Currency acceptance belongs to the host's settlement profile. */
export function createCommerceQuotePrimitives(commerceCurrencySchema: z.ZodType<string>) {
  const commerceTaxCountrySchema = z.string().trim().regex(/^[A-Z]{2}$/);
  const commerceTaxCategorySchema = z.string().trim().regex(/^[a-z][a-z0-9_]*$/);
  const commerceTaxLegalBasisSchema = z.string().trim().min(1).max(200);
  const commerceSkuSchema = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._:-]+$/);

  const commerceMoneySchema = z.object({
    amountMinor: z.number().int().nonnegative(),
    currency: commerceCurrencySchema,
  });

  return { commerceCurrencySchema, commerceTaxCountrySchema, commerceTaxCategorySchema, commerceTaxLegalBasisSchema, commerceSkuSchema, commerceMoneySchema };
}
