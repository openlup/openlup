import { z } from "../../lib/validation/zod.js";
import { customerDeliveryPickupPointSchema } from "./contracts.js";

export const customerOrderDeliverySelectionSchema = z
  .object({
    deliveryKind: z.enum(["courier", "parcel-locker"]),
    providerKind: z.string().max(80).nullable(),
    carrierKind: z.string().max(80).nullable(),
    carrierCode: z.string().max(80).nullable(),
    serviceCode: z.string().max(120).nullable(),
    pickupPoint: customerDeliveryPickupPointSchema.nullable(),
  })
  .strict();
