import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";
import { slugSchema } from "../catalog/contracts.js";
import { subscriptionSelfServiceActionSchema } from "../subscription/contracts.js";
import { SUBSCRIPTION_RECORD_STATUSES } from "../subscription/types.js";
import {
  canonicalActivityLevelSchema,
  canonicalBodyConditionSchema,
  canonicalPetAgeSchema,
  canonicalPetWeightKgSchema,
  normalizedDogBreedSchema,
  normalizedOptionalNameSchema,
  normalizedPetNameSchema,
  normalizedPolishPhoneSchema,
  optionalNullableField,
} from "./customerSelfServiceWriteSchemas.js";
import {
  customerAddressSchema,
  customerLifecycleStageSchema,
  customerOrdererProfileSchema,
  customerPaymentPreferenceSchema,
} from "./contracts.js";
export {
  customerAddressUpsertRequestSchema,
  type CustomerAddressUpsertRequest,
} from "./customerAddressSelfServiceContracts.js";

export const CUSTOMER_ACCOUNT_CONTRACT_VERSION = "customer.account.v1" as const;
export const CUSTOMER_SELF_SERVICE_CONTRACT_VERSION = "customer.self_service.v1" as const;

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z.string().trim().min(8).max(180);
const nullableTextSchema = z.string().trim().min(1).max(240).nullable();

export const customerAccountProfileSchema = z
  .object({
    clientId: uuidSchema,
    email: z.string().email(),
    firstName: z.string().max(120).nullable(),
    lastName: z.string().max(120).nullable(),
    phone: z.string().max(64).nullable(),
    lifecycleStage: customerLifecycleStageSchema,
  })
  .strict();

export const customerAccountPetSchema = z
  .object({
    petId: uuidSchema,
    petType: z.enum(["dog", "cat", "other"]),
    name: z.string().max(120).nullable(),
    breed: z.string().max(160).nullable(),
    ageLabel: z.string().max(80).nullable(),
    weightKg: z.number().positive().nullable(),
    activityLevel: z.string().max(80).nullable(),
    bodyCondition: z.string().max(80).nullable(),
    allergies: z.array(z.string().trim().min(1).max(120)),
    photoUrl: z.string().url().nullable(),
    removedAt: datetimeSchema.nullable(),
    createdAt: datetimeSchema,
    updatedAt: datetimeSchema,
  })
  .strict();

export const customerAccountSubscriptionLineSchema = z
  .object({
    lineId: uuidSchema,
    variantId: uuidSchema,
    qty: z.number().int().positive(),
    sortOrder: z.number().int(),
    isAddon: z.boolean(),
  })
  .strict();

export const customerAccountSubscriptionSchema = z
  .object({
    subscriptionId: uuidSchema,
    petId: uuidSchema.nullable(),
    status: z.enum(SUBSCRIPTION_RECORD_STATUSES),
    cadenceDays: z.number().int().positive(),
    nextCycleAt: datetimeSchema.nullable(),
    editCutoffAt: datetimeSchema.nullable(),
    paymentMethodKind: z.string().max(80).nullable(),
    templateVersion: z.number().int().positive(),
    sizeConstraint: z.record(z.string(), z.unknown()).nullable(),
    lines: z.array(customerAccountSubscriptionLineSchema),
  })
  .strict();

export const customerAccountOrderSchema = z
  .object({
    orderId: uuidSchema,
    orderRef: z.string().regex(/^order_[a-z0-9-]+$/),
    status: z.string().min(1),
    total: z.object({
      amountMinor: z.number().int().nonnegative(),
      currency: platformCurrencySchema,
    }),
    createdAt: datetimeSchema,
  })
  .strict();

export const customerAccountEventSchema = z
  .object({
    eventId: uuidSchema,
    eventType: z.string().min(1).max(120),
    entityType: z.string().min(1).max(80),
    entityId: uuidSchema.nullable(),
    occurredAt: datetimeSchema,
  })
  .strict();

export const customerAccountRequestSchema = z.object({}).strict();

export const customerAccountResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_ACCOUNT_CONTRACT_VERSION),
    profile: customerAccountProfileSchema,
    pets: z.array(customerAccountPetSchema),
    subscriptions: z.array(customerAccountSubscriptionSchema),
    addresses: z.array(customerAddressSchema),
    ordererProfiles: z.array(customerOrdererProfileSchema),
    paymentPreferences: z.array(customerPaymentPreferenceSchema),
    recentOrders: z.array(customerAccountOrderSchema),
    events: z.array(customerAccountEventSchema),
  })
  .strict();

export const customerProfileUpdateRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    firstName: optionalNullableField(normalizedOptionalNameSchema),
    lastName: optionalNullableField(normalizedOptionalNameSchema),
    phone: optionalNullableField(normalizedPolishPhoneSchema),
  })
  .strict();

export const customerProfileUpdateResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_SELF_SERVICE_CONTRACT_VERSION),
    profile: customerAccountProfileSchema,
  })
  .strict();

export const customerPetCreateRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    petType: z.literal("dog"),
    name: normalizedPetNameSchema,
    breed: optionalNullableField(normalizedDogBreedSchema),
    ageLabel: z.union([canonicalPetAgeSchema, z.null()]).optional(),
    weightKg: canonicalPetWeightKgSchema,
    activityLevel: z.union([canonicalActivityLevelSchema, z.null()]).optional(),
    bodyCondition: z.union([canonicalBodyConditionSchema, z.null()]).optional(),
    allergies: z.array(slugSchema).max(20).optional(),
    photoUrl: z.string().url().nullable().optional(),
  })
  .strict();

export const customerPetUpdateRequestSchema = customerPetCreateRequestSchema
  .omit({ petType: true, name: true })
  .extend({
    petId: uuidSchema,
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const customerPetDeleteRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    petId: uuidSchema,
    reason: nullableTextSchema.optional(),
  })
  .strict();

export const customerPetsResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_SELF_SERVICE_CONTRACT_VERSION),
    pets: z.array(customerAccountPetSchema),
  })
  .strict();

export const customerPetMutationResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_SELF_SERVICE_CONTRACT_VERSION),
    pet: customerAccountPetSchema,
  })
  .strict();

export const customerAddressDeleteRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    addressId: uuidSchema,
  })
  .strict();

const legacyCustomerSubscriptionActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("slide_next_cycle"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    newNextCycleAt: datetimeSchema,
    reason: nullableTextSchema.optional(),
  }),
  z.object({
    action: z.enum(["skip_next_cycle", "pause", "resume", "cancel"]),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    reason: nullableTextSchema.optional(),
  }),
  z.object({
    action: z.literal("swap_recipe"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    fromVariantId: uuidSchema,
    toVariantId: uuidSchema,
    acceptedQuoteHash: z.string().trim().regex(/^[a-f0-9]{64}$/).optional(),
  }),
  z.object({
    action: z.literal("update_cadence"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    cadenceDays: z.number().int().positive().max(90),
  }),
  z.object({
    action: z.literal("update_package"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    sizeConstraint: z.record(z.string(), z.unknown()),
  }),
  z.object({
    action: z.literal("add_addon"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    variantId: uuidSchema,
    qty: z.number().int().positive().max(99),
    acceptedQuoteHash: z.string().trim().regex(/^[a-f0-9]{64}$/).optional(),
  }),
  z.object({
    action: z.literal("remove_addon"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    variantId: uuidSchema,
    acceptedQuoteHash: z.string().trim().regex(/^[a-f0-9]{64}$/).optional(),
  }),
  // Coupled plan length: drives cadence + feeding_days; server recomputes the
  // can count (kcal × days) and re-splits across the current recipes.
  z.object({
    action: z.literal("update_plan_length"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    planDays: z.number().int().positive().max(90),
  }),
  // Full desired recipe composition (not a delta) at a FIXED total; the server
  // validates the sum against the current recipe total, reprices, rewrites lines.
  z.object({
    action: z.literal("update_recipe_mix"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    recipes: z
      .array(z.object({ variantId: uuidSchema, qty: z.number().int().positive().max(48) }))
      .min(1)
      .max(6),
  }),
]);

export const customerSubscriptionActionSchema = z.union([
  subscriptionSelfServiceActionSchema,
  legacyCustomerSubscriptionActionSchema,
]);

export {
  customerSubscriptionActionNameSchema,
  customerSubscriptionActionResponseSchema,
  type CustomerSubscriptionActionName,
  type CustomerSubscriptionActionResponse,
  type CustomerSubscriptionActionResult,
} from "./subscriptionActionResponseContracts.js";

export type CustomerAccountResponse = z.infer<typeof customerAccountResponseSchema>;
export type CustomerProfileUpdateRequest = z.infer<typeof customerProfileUpdateRequestSchema>;
export type CustomerProfileUpdateResponse = z.infer<typeof customerProfileUpdateResponseSchema>;
export type CustomerPetCreateRequest = z.infer<typeof customerPetCreateRequestSchema>;
export type CustomerPetUpdateRequest = z.infer<typeof customerPetUpdateRequestSchema>;
export type CustomerPetDeleteRequest = z.infer<typeof customerPetDeleteRequestSchema>;
export type CustomerPetsResponse = z.infer<typeof customerPetsResponseSchema>;
export type CustomerPetMutationResponse = z.infer<typeof customerPetMutationResponseSchema>;
export type CustomerAddressDeleteRequest = z.infer<typeof customerAddressDeleteRequestSchema>;
export type CustomerSubscriptionActionRequest = z.infer<typeof customerSubscriptionActionSchema>;
