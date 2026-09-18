import { z } from "../../lib/validation/zod.js";
import { deliveryCarrierKindSchema, pickupPointAddressSchema } from "./deliverySelectionContracts.js";

export const PICKUP_POINT_SEARCH_CONTRACT_VERSION = "shipping.pickup_point_search.v1";

// "Nearest pickup points" search for parcel-locker / PUDO carriers (InPost
// Paczkomaty now; Orlen Paczka once its API is wired). At least one locator is
// required: relative coordinates (best — sorts by real distance), a postal code,
// a city, or a free-text query.
export const pickupPointSearchRequestSchema = z
  .object({
    carrierKind: deliveryCarrierKindSchema,
    latitude: z.number().gte(-90).lte(90).optional(),
    longitude: z.number().gte(-180).lte(180).optional(),
    postalCode: z.string().trim().min(3).max(16).optional(),
    city: z.string().trim().min(2).max(120).optional(),
    query: z.string().trim().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (typeof value.latitude === "number" && typeof value.longitude === "number") ||
      Boolean(value.postalCode || value.city || value.query),
    { message: "provide latitude+longitude, or one of postalCode/city/query" },
  );

export const pickupPointSearchResultSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    carrierKind: deliveryCarrierKindSchema,
    name: z.string().trim().min(1).max(160),
    address: pickupPointAddressSchema,
    location: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
    locationDescription: z.string().max(240).nullable(),
    openingHours: z.string().max(120).nullable(),
    distanceMeters: z.number().nonnegative().nullable(),
    // Carrier-agnostic normalization of the vendor's point taxonomy, so the
    // contract carries no InPost-specific enums. InPost's display rules bind on
    // these: a locker must read "Paczkomat®" and a service point "PaczkoPunkt",
    // while an unrecognized kind (null) must stay unlabelled rather than guess.
    pointKind: z.enum(["locker", "service_point"]).nullable(),
    /** Point needs the carrier's app to open (InPost Appkomat) — must be disclosed. */
    appAssisted: z.boolean(),
  })
  .strict();

export const pickupPointSearchResponseSchema = z
  .object({
    contractVersion: z.literal(PICKUP_POINT_SEARCH_CONTRACT_VERSION),
    carrierKind: deliveryCarrierKindSchema,
    points: z.array(pickupPointSearchResultSchema).max(50),
  })
  .strict();

export type PickupPointSearchRequest = z.infer<typeof pickupPointSearchRequestSchema>;
export type PickupPointSearchResult = z.infer<typeof pickupPointSearchResultSchema>;
export type PickupPointSearchResponse = z.infer<typeof pickupPointSearchResponseSchema>;
