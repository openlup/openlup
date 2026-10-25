// Browser binding: pricing owns money; the host owns profile sizing.
import { z } from "../../lib/validation/zod.js";
import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { catalogProductSlugSchema } from "../catalog/contracts.js";
import { createCommerceQuotePrimitives } from "@openlup/platform/pricing/browser";
import { commerceSizeConstraintCoreSchema } from "@openlup/platform/commerce";
export { cartStatusSchema, checkoutStatusSchema, orderDraftStatusSchema, orderStatusSchema, paymentStatusSchema, commerceIdempotencyKeySchema } from "@openlup/platform/commerce";
const primitives = createCommerceQuotePrimitives(platformCurrencySchema);
export const { commerceTaxCountrySchema, commerceTaxCategorySchema, commerceTaxLegalBasisSchema, commerceSkuSchema } = primitives;
// Keep the exact host schema type: the existing pricing factory widens input.
export const commerceCurrencySchema = platformCurrencySchema;
export const commerceMoneySchema = primitives.commerceMoneySchema.extend({ currency: commerceCurrencySchema });
export const commerceProductSlugSchema = catalogProductSlugSchema;

export const commerceSizeConstraintSchema = commerceSizeConstraintCoreSchema
  .extend({
    kind: z.enum(["unit_count", "total_weight_g", "feeding_days"]),
    petId: z.string().trim().min(1).max(120).nullable().optional(),
    dailyKcalOverride: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .superRefine((constraint, ctx) => {
    if (constraint.kind === "feeding_days" && !constraint.dailyKcalOverride) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feeding_days size constraint requires dailyKcalOverride",
        path: ["dailyKcalOverride"],
      });
    }
  });
