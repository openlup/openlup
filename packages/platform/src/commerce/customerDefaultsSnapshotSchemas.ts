import { z } from "zod";
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


export function createCustomerDefaultsSnapshotSchemas<Scope extends z.ZodType, Method extends z.ZodType>(input: {
  paymentPreferenceScopeSchema: Scope; paymentMethodKindSchema: Method; additionalForbiddenKeys?: readonly string[];
}) {
  const customerPaymentPreferenceScopeSchema = input.paymentPreferenceScopeSchema;
  const customerPaymentMethodKindSchema = input.paymentMethodKindSchema;
  const forbiddenKeys = new Set([...FORBIDDEN_DEFAULTS_KEYS, ...(input.additionalForbiddenKeys ?? [])]);
  const commerceCustomerDefaultsSnapshotSchema = z
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
      const forbiddenPath = findForbiddenDefaultsPath(snapshot, [], forbiddenKeys);
      if (forbiddenPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "customer defaults snapshot cannot include raw PII, address or payment payloads",
          path: forbiddenPath,
        });
      }
    });

  return { commerceCustomerDefaultsSnapshotSchema };
}

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
  "card",
  "rawFormPayload",
]);

function findForbiddenDefaultsPath(
  value: unknown,
  path: (string | number)[] = [],
  forbiddenKeys: ReadonlySet<string> = FORBIDDEN_DEFAULTS_KEYS,
): (string | number)[] | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findForbiddenDefaultsPath(item, [...path, index], forbiddenKeys);
      if (result) return result;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) return [...path, key];
    const result = findForbiddenDefaultsPath(nestedValue, [...path, key], forbiddenKeys);
    if (result) return result;
  }

  return null;
}
