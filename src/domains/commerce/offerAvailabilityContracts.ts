import { createOfferAvailabilitySchemas } from "@openlup/platform/commerce";
import { catalogProductSlugSchema } from "../catalog/contracts.js";
import { commerceSkuSchema } from "./contractPrimitives.js";
export const { commerceOfferAvailabilityStatusSchema, commerceOfferAvailabilitySourceSchema,
  commerceOfferAvailabilityRequestItemSchema, commerceOfferAvailabilitySchema } = createOfferAvailabilitySchemas(catalogProductSlugSchema, commerceSkuSchema);
export { offerAvailabilityRequestItems } from "@openlup/platform/commerce";
export type { CommerceOfferAvailabilityStatus, CommerceOfferAvailabilityRequestItem, CommerceOfferAvailability } from "@openlup/platform/commerce/contracts";
