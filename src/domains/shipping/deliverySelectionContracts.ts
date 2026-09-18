import { z } from "../../lib/validation/zod.js";

export const DELIVERY_SELECTION_CONTRACT_VERSION = "shipping.delivery_selection.v1";

// THE live production menu. Every entry is intentionally enabled; this list IS
// the declaration and nothing else has to be configured for it to be offered.
// The allowlist env var can only NARROW it — see resolveDeliverySelectionPort.
//
// ⛔ Each entry keeps carrierCode === serviceCode: a hard provider invariant
// (bare family codes are rejected). Enforced by deliveryOptionSchema below.
export const OMNIPACK_DELIVERY_OPTIONS = [
  {
    id: "inpost-locker-standard",
    kind: "parcel-locker",
    deliveryKind: "parcel-locker",
    providerKind: "omnipack",
    carrierKind: "inpost",
    carrierCode: "INPOST_LOCKER_STANDARD",
    service: "inpost_locker_standard",
    serviceCode: "INPOST_LOCKER_STANDARD",
    label: "Paczkomat InPost",
    description: "Odbiór w wybranym punkcie InPost.",
    pickupPointRequired: true,
    addressRequired: false,
  },
  {
    id: "inpost-courier-standard",
    kind: "courier",
    deliveryKind: "courier",
    providerKind: "omnipack",
    carrierKind: "inpost",
    carrierCode: "INPOST_COURIER_STANDARD",
    service: "inpost_courier_standard",
    serviceCode: "INPOST_COURIER_STANDARD",
    label: "Kurier InPost",
    description: "Dostawa kurierem pod wskazany adres.",
    pickupPointRequired: false,
    addressRequired: true,
  },
  {
    id: "dpd-courier-standard",
    kind: "courier",
    deliveryKind: "courier",
    providerKind: "omnipack",
    carrierKind: "dpd",
    carrierCode: "DPD_COURIER_STANDARD",
    service: "dpd_courier_standard",
    serviceCode: "DPD_COURIER_STANDARD",
    label: "Kurier DPD",
    description: "Dostawa kurierem pod wskazany adres.",
    pickupPointRequired: false,
    addressRequired: true,
  },
  {
    id: "dhl-courier-omnipack",
    kind: "courier",
    deliveryKind: "courier",
    providerKind: "omnipack",
    carrierKind: "dhl",
    carrierCode: "DHL_COURIER_STANDARD",
    service: "dhl_courier_standard",
    serviceCode: "DHL_COURIER_STANDARD",
    label: "Kurier DHL",
    description: "Dostawa kurierem pod wskazany adres.",
    pickupPointRequired: false,
    addressRequired: true,
  },
] as const;

// Carrier kinds present in the declared set, derived from the options themselves
// so the two can never drift apart. A hand-maintained duplicate of this list is
// what previously let a carrier be enabled by accident rather than declaration.
export const OMNIPACK_DELIVERY_CARRIER_KINDS: readonly string[] = [
  ...new Set(OMNIPACK_DELIVERY_OPTIONS.map((option) => option.carrierKind)),
];

export const deliveryKindSchema = z.enum(["parcel-locker", "courier"]);
export const deliveryProviderKindSchema = z.enum(["omnipack", "dhl", "manual", "simulator"]);
// Carrier kind + service code are no longer a fixed allowlist: the set of
// carriers/services is whatever OmniPack confirms for the merchant account (no
// dictionary API — values come from the merchant dictionary config). Validated
// as normalized slugs/codes so the dictionary-driven options + the checkout
// selection stay well-formed without hardcoding InPost/DPD/DHL.
export const deliveryCarrierKindSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "carrierKind must be a lowercase slug");
export const deliveryServiceSchema = z.string().trim().min(1).max(120);

export const pickupPointAddressSchema = z
  .object({
    line1: z.string().trim().min(3).max(160),
    postalCode: z.string().trim().min(3).max(16),
    city: z.string().trim().min(2).max(120),
    country: z.literal("PL"),
  })
  .strict();

export const pickupPointSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    provider: deliveryCarrierKindSchema,
    name: z.string().trim().min(1).max(120),
    address: pickupPointAddressSchema,
  })
  .strict();

export const deliveryOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    kind: deliveryKindSchema,
    deliveryKind: deliveryKindSchema.optional(),
    providerKind: deliveryProviderKindSchema,
    carrierKind: deliveryCarrierKindSchema,
    carrierCode: z.string().trim().min(1).max(80),
    service: deliveryServiceSchema,
    serviceCode: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(240),
    pickupPointRequired: z.boolean(),
    addressRequired: z.boolean(),
  })
  .strict()
  .refine((option) => option.providerKind !== "omnipack" || option.carrierCode === option.serviceCode, {
    message: "OmniPack delivery requires carrierCode to equal serviceCode",
    path: ["carrierCode"],
  })
  .transform((option) => ({ ...option, deliveryKind: option.deliveryKind ?? option.kind }));

export const deliveryOptionsResponseSchema = z
  .object({
    contractVersion: z.literal(DELIVERY_SELECTION_CONTRACT_VERSION),
    options: z.array(deliveryOptionSchema).min(1).max(10),
  })
  .strict();

export const pickupPointValidationRequestSchema = z
  .object({
    pointId: z.string().trim().min(1).max(80),
    carrierKind: deliveryCarrierKindSchema,
  })
  .strict();

export const pickupPointValidationResponseSchema = z
  .object({
    contractVersion: z.literal(DELIVERY_SELECTION_CONTRACT_VERSION),
    valid: z.boolean(),
    pickupPoint: pickupPointSchema.nullable(),
  })
  .strict()
  .refine((value) => (value.valid ? value.pickupPoint !== null : true), {
    message: "valid pickup point responses require pickupPoint",
    path: ["pickupPoint"],
  });

export type DeliveryKind = z.infer<typeof deliveryKindSchema>;
export type DeliveryProviderKind = z.infer<typeof deliveryProviderKindSchema>;
export type DeliveryCarrierKind = z.infer<typeof deliveryCarrierKindSchema>;
export type DeliveryService = z.infer<typeof deliveryServiceSchema>;
export type PickupPoint = z.infer<typeof pickupPointSchema>;
export type DeliveryOption = z.infer<typeof deliveryOptionSchema>;
export type DeliveryOptionsResponse = z.infer<typeof deliveryOptionsResponseSchema>;
export type PickupPointValidationRequest = z.infer<typeof pickupPointValidationRequestSchema>;
export type PickupPointValidationResponse = z.infer<typeof pickupPointValidationResponseSchema>;
