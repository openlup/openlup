import { z } from "../../lib/validation/zod.js";
import { commerceProductSlugSchema, commerceSkuSchema } from "./contractPrimitives.js";
import { createCheckoutResumeSchemas, checkoutResumeCompletionCoreSchema } from "@openlup/platform/commerce";
export { CHECKOUT_RESUME_CONTRACT_VERSION, checkoutResumeTokenSchema, checkoutResumeModeSchema } from "@openlup/platform/commerce";
import { checkoutResumeTokenSchema } from "@openlup/platform/commerce";
export const checkoutResumeSectionIdSchema = z.enum([
  "start",
  "pet_profile",
  "product_selection",
  "cadence",
  "account",
  "shipping",
  "billing",
  "payment",
  "review",
]);

export const checkoutResumeRedactedFieldSchema = z.enum([
  "pet_identity",
  "contact",
  "shipping_address",
  "billing_address",
  "delivery_notes",
  "courier_instructions",
  "payment_provider",
  "payment_secret",
  "raw_form_payload",
]);

const checkoutResumeCompletionSchema = z.object({ petProfile: z.boolean().default(false) })
  .merge(checkoutResumeCompletionCoreSchema).strict().default({ petProfile: false, productSelection: false,
    cadence: false, account: false, shipping: false, billing: false, payment: false, review: false });
export const { checkoutResumeDraftStateSchema, checkoutResumeUpsertRequestSchema, checkoutResumeReadRequestSchema, checkoutResumeDraftSchema, checkoutResumeUpsertResponseSchema, checkoutResumeReadResponseSchema } = createCheckoutResumeSchemas({
  sectionSchema: checkoutResumeSectionIdSchema, redactedFieldSchema: checkoutResumeRedactedFieldSchema,
  completionSchema: checkoutResumeCompletionSchema, productSlugSchema: commerceProductSlugSchema,
  skuSchema: commerceSkuSchema, additionalForbiddenKeys: ["blik"],
});
export type CheckoutResumeToken = z.infer<typeof checkoutResumeTokenSchema>;
export type CheckoutResumeSectionId = z.infer<typeof checkoutResumeSectionIdSchema>;
export type CheckoutResumeDraftState = z.infer<typeof checkoutResumeDraftStateSchema>;
export type CheckoutResumeUpsertRequest = z.infer<typeof checkoutResumeUpsertRequestSchema>;
export type CheckoutResumeReadRequest = z.infer<typeof checkoutResumeReadRequestSchema>;
export type CheckoutResumeDraft = z.infer<typeof checkoutResumeDraftSchema>;
export type CheckoutResumeUpsertResponse = z.infer<typeof checkoutResumeUpsertResponseSchema>;
export type CheckoutResumeReadResponse = z.infer<typeof checkoutResumeReadResponseSchema>;
