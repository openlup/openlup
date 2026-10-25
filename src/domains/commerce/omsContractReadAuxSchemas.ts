import { omsPricingSummarySchema as neutralPricing } from "@openlup/platform/commerce";
import { z } from "../../lib/validation/zod.js";
import { commerceMoneySchema } from "./contracts.js";
export { omsCommunicationDeliverySchema, omsCommunicationDeliveryStatusSchema, omsDeliveryContactProjectionSchema, omsDeliveryContactResolutionSchema, omsDeliveryContactSchema, omsDeliverySelectionSchema } from "@openlup/platform/commerce";
export const omsFirstSubscriptionPricePresentationSchema = z.object({
  catalogProducts: commerceMoneySchema,
  productDiscount: commerceMoneySchema,
  productPayable: commerceMoneySchema,
  shipping: commerceMoneySchema,
  shippingDiscount: commerceMoneySchema,
  shippingEffective: commerceMoneySchema,
  total: commerceMoneySchema,
  discountPercent: z.literal(50),
}).strict();
export const omsPricingSummarySchema = neutralPricing.extend({ subtotal: commerceMoneySchema, productDiscount: commerceMoneySchema, shipping: commerceMoneySchema, shippingDiscount: commerceMoneySchema, discountTotal: commerceMoneySchema, finalTotal: commerceMoneySchema });
