import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";

import { customerReturnToSchema } from "./customerReturnTo.js";

export { customerReturnToSchema, normalizeCustomerReturnTo } from "./customerReturnTo.js";

// Faza A W12.1 — hidden passwordless customer account contracts.

export const CUSTOMER_PREFERENCES_CONTRACT_VERSION = "customer.preferences.v1" as const;
export const CUSTOMER_ADDRESSES_CONTRACT_VERSION = "customer.addresses.v1" as const;
export const CUSTOMER_PAYMENT_METHODS_CONTRACT_VERSION = "customer.payment_methods.v1" as const;

export const customerLifecycleStageSchema = z.enum([
  "lead",
  "tester",
  "customer",
  "inactive",
]);

export const customerMeRequestSchema = z.object({}).strict();

export const customerMeResponseSchema = z.object({
  clientId: z.string().min(1),
  email: z.string().min(1),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  lifecycleStage: customerLifecycleStageSchema,
  subscriptions: z
    .array(
      z
        .object({
          subscriptionId: z.guid(),
          status: z.string().min(1),
          cadenceDays: z.number().int().positive(),
          nextCycleAt: z.string().datetime({ offset: true }).nullable(),
          paymentMethodKind: z.string().nullable(),
        })
        .strict(),
    )
    .optional(),
  recentOrders: z
    .array(
      z
        .object({
          orderId: z.guid(),
          orderRef: z.string().regex(/^order_[a-z0-9-]+$/),
          status: z.string().min(1),
          mode: z.enum(["one_time", "subscription_cycle"]),
          total: z.object({
            amountMinor: z.number().int().nonnegative(),
            currency: platformCurrencySchema,
          }),
          createdAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    )
    .optional(),
});

export const customerMagicLinkRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(160),
    locale: z.enum(["pl", "en"]).default("pl"),
    returnTo: customerReturnToSchema.optional(),
  })
  .strict();

export const customerMagicLinkResponseSchema = z
  .object({
    accepted: z.literal(true),
  })
  .strict();

export const customerPaymentPreferenceScopeSchema = z.enum(["one_time", "subscription", "any"]);
export const customerPaymentMethodKindSchema = z.enum(["blik", "card", "transfer"]);

const datetimeSchema = z.string().datetime({ offset: true });

export const customerPaymentPreferenceSchema = z
  .object({
    scope: customerPaymentPreferenceScopeSchema,
    methodKind: customerPaymentMethodKindSchema,
    lastSelectedAt: datetimeSchema,
  })
  .strict();

export const customerPaymentPreferencesResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_PREFERENCES_CONTRACT_VERSION),
    preferences: z.array(customerPaymentPreferenceSchema),
  })
  .strict();

export const customerPaymentPreferenceUpsertRequestSchema = z
  .object({
    scope: customerPaymentPreferenceScopeSchema,
    methodKind: customerPaymentMethodKindSchema,
  })
  .strict();

export const customerPaymentPreferenceUpsertResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_PREFERENCES_CONTRACT_VERSION),
    preference: customerPaymentPreferenceSchema,
  })
  .strict();

export const customerSavedPaymentMethodProviderSchema = z.literal("tpay");
export const customerSavedPaymentMethodKindSchema = z.literal("blik_payid");
export const customerSavedPaymentMethodStatusSchema = z.literal("active");
export const customerSavedPaymentMethodUsageSchema = z.enum(["one_time", "subscription"]);

export const customerSavedPaymentMethodSchema = z
  .object({
    id: z.guid(),
    provider: customerSavedPaymentMethodProviderSchema,
    methodKind: customerSavedPaymentMethodKindSchema,
    status: customerSavedPaymentMethodStatusSchema,
    usableFor: z.array(customerSavedPaymentMethodUsageSchema).min(1),
    label: z.string().trim().min(1).max(80),
  })
  .strict();

export const customerPaymentMethodsResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_PAYMENT_METHODS_CONTRACT_VERSION),
    paymentMethods: z.array(customerSavedPaymentMethodSchema),
  })
  .strict();

// Default delivery preference (carrier/service + pickup point) per scope. UI-safe
// facts only; mirrors the payment-preference surface. Reused at checkout prefill
// and for subscription renewals.
export const CUSTOMER_DELIVERY_PREFERENCES_CONTRACT_VERSION = "customer.delivery_preferences.v1" as const;
export const customerDeliveryPreferenceScopeSchema = z.enum(["one_time", "subscription", "any"]);
export const customerDeliveryKindSchema = z.enum(["courier", "parcel-locker"]);
export const customerDeliveryProviderKindSchema = z.enum(["omnipack", "dhl", "manual", "simulator"]);

export const customerDeliveryPickupPointSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(160),
    address: z
      .object({
        line1: z.string().trim().min(1).max(160),
        postalCode: z.string().trim().min(3).max(16),
        city: z.string().trim().min(1).max(120),
        country: z.string().trim().length(2),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

export const customerDeliveryPreferenceSchema = z
  .object({
    scope: customerDeliveryPreferenceScopeSchema,
    deliveryKind: customerDeliveryKindSchema,
    providerKind: customerDeliveryProviderKindSchema,
    carrierKind: z.string().trim().min(2).max(40),
    carrierCode: z.string().trim().min(1).max(80),
    serviceCode: z.string().trim().min(1).max(120),
    pickupPoint: customerDeliveryPickupPointSchema.nullable(),
    lastSelectedAt: datetimeSchema,
  })
  .strict();

export const customerDeliveryPreferencesResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_DELIVERY_PREFERENCES_CONTRACT_VERSION),
    preferences: z.array(customerDeliveryPreferenceSchema),
  })
  .strict();

export const customerDeliveryPreferenceUpsertRequestSchema = z
  .object({
    scope: customerDeliveryPreferenceScopeSchema,
    deliveryKind: customerDeliveryKindSchema,
    providerKind: customerDeliveryProviderKindSchema,
    carrierKind: z.string().trim().min(2).max(40),
    carrierCode: z.string().trim().min(1).max(80),
    serviceCode: z.string().trim().min(1).max(120),
    pickupPoint: customerDeliveryPickupPointSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.deliveryKind === "parcel-locker" && !value.pickupPoint) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "parcel-locker preference requires a pickupPoint", path: ["pickupPoint"] });
    }
  });

export const customerDeliveryPreferenceUpsertResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_DELIVERY_PREFERENCES_CONTRACT_VERSION),
    preference: customerDeliveryPreferenceSchema,
  })
  .strict();

export type CustomerDeliveryPreference = z.infer<typeof customerDeliveryPreferenceSchema>;
export type CustomerDeliveryPreferencesResponse = z.infer<typeof customerDeliveryPreferencesResponseSchema>;
export type CustomerDeliveryPreferenceUpsertRequest = z.infer<typeof customerDeliveryPreferenceUpsertRequestSchema>;
export type CustomerDeliveryPreferenceUpsertResponse = z.infer<typeof customerDeliveryPreferenceUpsertResponseSchema>;

export const customerAddressKindSchema = z.enum(["shipping", "billing", "both"]);

export const customerAddressSchema = z
  .object({
    addressId: z.guid(),
    kind: customerAddressKindSchema,
    label: z.string().max(120).nullable(),
    recipientName: z.string().max(200).nullable(),
    contactPhone: z.string().max(64).nullable(),
    companyName: z.string().max(200).nullable(),
    taxId: z.string().max(64).nullable(),
    line1: z.string().min(1),
    line2: z.string().nullable(),
    city: z.string().min(1),
    postalCode: z.string().min(1),
    country: z.string().min(2).max(3),
    isDefault: z.boolean(),
    deliveryNotes: z.string().max(500).nullable(),
    courierInstructions: z.string().max(500).nullable(),
    lastUsedAt: datetimeSchema.nullable(),
    createdAt: datetimeSchema,
    updatedAt: datetimeSchema,
  })
  .strict();

export const customerOrdererProfileSchema = z
  .object({
    profileId: z.guid(),
    label: z.string().max(120).nullable(),
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().max(64).nullable(),
    companyName: z.string().max(200).nullable(),
    taxId: z.string().max(64).nullable(),
    companyVerificationLevel: z.enum(["registry_verified", "provider_verified", "manual_unverified", "invalid"]).nullable().optional(),
    companyIdentitySource: z.string().max(120).nullable().optional(),
    companyIdentityEvidenceHash: z.string().max(160).nullable().optional(),
    isDefault: z.boolean(),
    createdAt: datetimeSchema,
    updatedAt: datetimeSchema,
  })
  .strict();

export const customerAddressesRequestSchema = z.object({}).strict();

export const customerAddressesResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_ADDRESSES_CONTRACT_VERSION),
    ordererProfiles: z.array(customerOrdererProfileSchema),
    addresses: z.array(customerAddressSchema),
  })
  .strict();

export type CustomerLifecycleStage = z.infer<typeof customerLifecycleStageSchema>;
export type CustomerMeRequest = z.infer<typeof customerMeRequestSchema>;
export type CustomerMeResponse = z.infer<typeof customerMeResponseSchema>;
export type CustomerMagicLinkRequest = z.infer<typeof customerMagicLinkRequestSchema>;
export type CustomerMagicLinkResponse = z.infer<typeof customerMagicLinkResponseSchema>;
export type CustomerPaymentPreferenceScope = z.infer<typeof customerPaymentPreferenceScopeSchema>;
export type CustomerPaymentMethodKind = z.infer<typeof customerPaymentMethodKindSchema>;
export type CustomerPaymentPreference = z.infer<typeof customerPaymentPreferenceSchema>;
export type CustomerPaymentPreferencesResponse = z.infer<
  typeof customerPaymentPreferencesResponseSchema
>;
export type CustomerPaymentPreferenceUpsertRequest = z.infer<
  typeof customerPaymentPreferenceUpsertRequestSchema
>;
export type CustomerPaymentPreferenceUpsertResponse = z.infer<
  typeof customerPaymentPreferenceUpsertResponseSchema
>;
export type CustomerSavedPaymentMethod = z.infer<typeof customerSavedPaymentMethodSchema>;
export type CustomerPaymentMethodsResponse = z.infer<
  typeof customerPaymentMethodsResponseSchema
>;
export type CustomerAddressKind = z.infer<typeof customerAddressKindSchema>;
export type CustomerAddress = z.infer<typeof customerAddressSchema>;
export type CustomerOrdererProfile = z.infer<typeof customerOrdererProfileSchema>;
export type CustomerAddressesRequest = z.infer<typeof customerAddressesRequestSchema>;
export type CustomerAddressesResponse = z.infer<typeof customerAddressesResponseSchema>;
