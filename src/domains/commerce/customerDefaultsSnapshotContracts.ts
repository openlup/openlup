import { z } from "../../lib/validation/zod.js";
import {
  customerPaymentMethodKindSchema,
  customerPaymentPreferenceScopeSchema,
} from "../customers/contracts.js";

export const CUSTOMER_DEFAULTS_SNAPSHOT_VERSION =
  "commerce.customer_defaults_snapshot.v1";

const uuidSchema = z.guid();
export const commerceCustomerDefaultsRedactedFieldSchema = z.enum([
  "contact",
  "orderer_profile",
  "shipping_address",
  "billing_address",
  "delivery_notes",
  "courier_instructions",
  "payment_provider",
  "payment_secret",
]);

export const commerceCustomerDefaultsSnapshotSchema = z
  .object({
    version: z.literal(CUSTOMER_DEFAULTS_SNAPSHOT_VERSION),
    clientId: uuidSchema,
    payment: z
      .object({
        available: z.boolean(),
        scope: customerPaymentPreferenceScopeSchema.nullable(),
        methodKind: customerPaymentMethodKindSchema.nullable(),
        source: z.literal("customer_payment_preferences"),
        applied: z.literal(false),
      })
      .strict(),
    addresses: z
      .object({
        hasDefaultShippingAddress: z.boolean(),
        defaultShippingAddressId: uuidSchema.nullable(),
        hasDefaultBillingAddress: z.boolean(),
        defaultBillingAddressId: uuidSchema.nullable(),
        hasDefaultOrdererProfile: z.boolean(),
        defaultOrdererProfileId: uuidSchema.nullable(),
        hasDeliveryNotes: z.boolean(),
        hasCourierInstructions: z.boolean(),
        source: z.literal("customer_address_profiles"),
        applied: z.literal(false),
      })
      .strict(),
    redactedFields: z.array(commerceCustomerDefaultsRedactedFieldSchema).default([]),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const forbiddenPath = findForbiddenDefaultsPath(snapshot);
    if (forbiddenPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "customer defaults snapshot cannot include raw PII, address or payment payloads",
        path: forbiddenPath,
      });
    }
  });

export type CommerceCustomerDefaultsSnapshot = z.infer<
  typeof commerceCustomerDefaultsSnapshotSchema
>;

const FORBIDDEN_DEFAULTS_KEYS = new Set([
  "name",
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "contactPhone",
  "recipientName",
  "companyName",
  "taxId",
  "line1",
  "line2",
  "street",
  "postalCode",
  "city",
  "country",
  "address",
  "deliveryNotes",
  "courierInstructions",
  "providerPayload",
  "pspReference",
  "paymentProvider",
  "paymentMethodRef",
  "blik",
  "card",
  "rawFormPayload",
]);

function findForbiddenDefaultsPath(
  value: unknown,
  path: (string | number)[] = [],
): (string | number)[] | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findForbiddenDefaultsPath(item, [...path, index]);
      if (result) return result;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_DEFAULTS_KEYS.has(key)) return [...path, key];
    const result = findForbiddenDefaultsPath(nestedValue, [...path, key]);
    if (result) return result;
  }

  return null;
}
