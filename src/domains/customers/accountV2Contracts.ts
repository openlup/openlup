import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";
import { customerAddressSchema, customerDeliveryPreferenceSchema, customerOrdererProfileSchema, customerPaymentPreferenceSchema } from "./contracts.js";
import { customerAccountEventSchema, customerAccountPetSchema, customerAccountProfileSchema, customerAccountRequestSchema } from "./selfServiceContracts.js";
import { customerAccountActionRequiredSchema } from "./accountActionRequiredContracts.js";
import { customerOrderDeliverySelectionSchema } from "./accountOrderDeliveryContracts.js";
import { isValidPolishNip, normalizePolishNip } from "../../lib/schemas/fields/taxId.js";
import { subscriptionPaymentMethodStatusSchema } from "../subscription/contracts.js";
import { SUBSCRIPTION_RECORD_STATUSES } from "../subscription/types.js";
import {
  customerInvoiceDocumentSchema,
  customerInvoiceRequestStatusSchema,
  customerInvoiceSummarySchema,
} from "./accountInvoiceContracts.js";
export {
  customerDocumentDeliveryStatusSchema,
  customerInvoiceDocumentRoleSchema,
  customerInvoiceDocumentSchema,
  customerInvoiceDownloadArtifactSchema,
  customerInvoiceDownloadRequestSchema,
  customerInvoiceRequestStatusSchema,
  customerInvoiceSummarySchema,
} from "./accountInvoiceContracts.js";
export type {
  CustomerDocumentDeliveryStatus,
  CustomerInvoiceDocumentRole,
  CustomerInvoiceDownloadArtifact,
  CustomerInvoiceDownloadRequest,
} from "./accountInvoiceContracts.js";
export const CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION = "customer.account.v3" as const;
export const CUSTOMER_ORDERS_CONTRACT_VERSION = "customer.orders.v2" as const;
export const CUSTOMER_BILLING_CONTRACT_VERSION = "customer.billing.v1" as const;
const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z.string().trim().min(8).max(180);
const nullableTextSchema = z.string().trim().min(1).max(500).nullable();
const optionalPolishNipSchema = z
  .string()
  .trim()
  .max(64)
  .nullable()
  .optional()
  .transform((value, ctx): string | null | undefined => {
    if (value === undefined) return undefined;
    const normalizedTaxId = normalizePolishNip(value);
    if (!normalizedTaxId) return null;
    if (!isValidPolishNip(normalizedTaxId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "forms:fields.taxId.invalid",
      });
      return z.NEVER;
    }
    return normalizedTaxId;
  });
const moneySchema = z.object({ amountMinor: z.number().int().nonnegative(), currency: platformCurrencySchema });
const subscriptionRecurringPriceSchema = z.object({ subtotalGross: moneySchema, totalGross: moneySchema, currency: platformCurrencySchema, source: z.enum(["frozen_quote_line", "missing"]) }).strict();
// Customer-safe read fact for the delivery-aware renewal boundary. It is absent
// while the rollout is off/shadowed and for legacy subscriptions; money,
// provider-attempt, and operator-review details deliberately stay server-only.
export const customerDeliveryAlignmentSchema = z
  .object({ state: z.enum(["protected", "aligned"]) })
  .strict();
export const customerAccountV2SubscriptionLineSchema = z
  .object({
    lineId: uuidSchema,
    variantId: uuidSchema,
    qty: z.number().int().positive(),
    sortOrder: z.number().int(),
    isAddon: z.boolean(),
    title: z.string().max(240).nullable(),
    sku: z.string().max(120).nullable(),
    recipeName: z.string().max(160).nullable(),
    productSlug: z.string().trim().min(1).max(120).nullable().optional(),
    flavourSlug: z.string().trim().min(1).max(120).nullable().optional(),
    displayLabel: z.string().trim().min(1).max(240).nullable().optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    unitPrice: moneySchema.nullable().optional(),
    lineSubtotal: moneySchema.nullable().optional(),
  })
  .strict();

export const customerAccountV2SubscriptionSchema = z
  .object({
    subscriptionId: uuidSchema,
    petId: uuidSchema.nullable(),
    shippingAddressId: uuidSchema.nullable(),
    status: z.enum(SUBSCRIPTION_RECORD_STATUSES),
    pausePreset: z.enum(["2_weeks", "1_month", "indefinite"]).nullable(),
    pauseStartedAt: datetimeSchema.nullable(),
    pauseEndsAt: datetimeSchema.nullable(),
    cadenceDays: z.number().int().positive(),
    nextCycleAt: datetimeSchema.nullable(),
    deliveryAlignment: customerDeliveryAlignmentSchema.optional(),
    editCutoffAt: datetimeSchema.nullable(),
    canEditUpcomingPackage: z.boolean(),
    editBlockedReason: z.enum(["not_active", "edit_window_closed", "cycle_locked", "payment_blocked", "missing_payment_method"]).nullable(),
    paymentMethodKind: z.string().max(80).nullable(),
    paymentMethodStatus: subscriptionPaymentMethodStatusSchema.optional(),
    templateVersion: z.number().int().positive(),
    sizeConstraint: z.record(z.string(), z.unknown()).nullable(),
    packageSummary: z.string().max(240).nullable(),
    recurringPrice: subscriptionRecurringPriceSchema.nullable(),
    lines: z.array(customerAccountV2SubscriptionLineSchema),
  })
  .strict();

export const customerOrderLineSchema = z
  .object({
    lineId: uuidSchema,
    skuId: uuidSchema.nullable(),
    title: z.string().min(1).max(240),
    quantity: z.number().int().positive(),
    unitPrice: moneySchema,
    total: moneySchema,
    recipeName: z.string().max(160).nullable(),
    variantName: z.string().max(160).nullable(),
    productSlug: z.string().trim().min(1).max(120).nullable().optional(),
    flavourSlug: z.string().trim().min(1).max(120).nullable().optional(),
    displayLabel: z.string().trim().min(1).max(240).nullable().optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    // Undiscounted list total + per-line saving (base_unit components − paid). Optional/null when no breakdown.
    listTotal: moneySchema.nullable().optional(),
    discount: moneySchema.nullable().optional(),
  })
  .strict();

export const customerOrderTrackingReferenceSchema = z
  .object({
    providerKind: z.string().min(1).max(80),
    trackingNumber: z.string().min(1).max(160),
    trackingUrl: z.string().url().max(500).nullable(),
    carrierKind: z.string().max(80).nullable(),
    service: z.string().max(120).nullable(),
    updatedAt: datetimeSchema.nullable(),
  })
  .strict();

export const customerOrderTrackingTimelineEventSchema = z
  .object({
    eventType: z.string().min(1).max(120),
    label: z.string().min(1).max(160),
    occurredAt: datetimeSchema.nullable(),
    source: z.enum(["webhook", "reconciliation", "manual", "simulator", "fulfillment"]),
  })
  .strict();

export const customerOrderFulfillmentSummarySchema = z
  .object({
    fulfillmentOrderId: uuidSchema.nullable(),
    status: z.string().max(80).nullable(),
    providerKind: z.string().max(80).nullable(),
    trackingNumber: z.string().max(160).nullable(),
    trackingNumbers: z.array(z.string().min(1).max(160)),
    trackingReferences: z.array(customerOrderTrackingReferenceSchema),
    lastEventType: z.string().max(120).nullable(),
    updatedAt: datetimeSchema.nullable(),
    trackingTimeline: z.array(customerOrderTrackingTimelineEventSchema),
  })
  .strict();

export const customerOrderSummarySchema = z
  .object({
    orderId: uuidSchema,
    orderRef: z.string().regex(/^order_[a-z0-9-]+$/),
    orderNumber: z.string().max(80).nullable(),
    // Owning subscription (null for one-time orders). Drives the orders-list
    // recovery routing: one-time/first-cycle → checkout-recovery; a subscription
    // in payment-block (dunning) → subscription payment recovery.
    subscriptionId: uuidSchema.nullable(),
    status: z.string().min(1).max(80),
    paymentStatus: z.string().max(80).nullable(),
    fulfillmentStatus: z.string().max(80).nullable(),
    // Derived server-side from durable fulfillment and the exact released-hold
    // recovery authority. Optional preserves clients parsing an older response.
    customerFulfillmentStep: z.enum(["paid", "accepted", "packing", "transit", "delivered", "exception", "cancelled"]).optional(),
    total: moneySchema,
    trackingNumber: z.string().max(160).nullable(),
    trackingNumbers: z.array(z.string().min(1).max(160)),
    trackingUrl: z.string().url().max(500).nullable(),
    carrierKind: z.string().max(80).nullable(),
    service: z.string().max(120).nullable(),
    trackingReferences: z.array(customerOrderTrackingReferenceSchema),
    trackingTimeline: z.array(customerOrderTrackingTimelineEventSchema),
    deliverySelection: customerOrderDeliverySelectionSchema.nullable().default(null),
    invoice: customerInvoiceSummarySchema.nullable(),
    invoiceDocuments: z.array(customerInvoiceDocumentSchema).default([]),
    invoiceRequestStatus: customerInvoiceRequestStatusSchema,
    createdAt: datetimeSchema,
    updatedAt: datetimeSchema,
  })
  .strict();

export const customerOrderDetailSchema = customerOrderSummarySchema
  .extend({
    subtotal: moneySchema,
    discount: moneySchema,
    shipping: moneySchema,
    tax: moneySchema,
    lines: z.array(customerOrderLineSchema),
    fulfillment: customerOrderFulfillmentSummarySchema.nullable(),
  })
  .strict();

export const customerOrdersListRequestSchema = z
  .object({
    limit: z.coerce.number().int().positive().max(50).default(20),
  })
  .strict();

export const customerOrderDetailRequestSchema = z.object({ orderId: uuidSchema }).strict();
export const customerOrdersListResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_ORDERS_CONTRACT_VERSION),
    orders: z.array(customerOrderSummarySchema),
  })
  .strict();

export const customerOrderDetailResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_ORDERS_CONTRACT_VERSION),
    order: customerOrderDetailSchema,
  })
  .strict();

export const customerBillingProfileUpsertRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    profileId: uuidSchema.optional(),
    label: z.string().trim().max(120).nullable().optional(),
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(320),
    phone: z.string().trim().max(64).nullable().optional(),
    companyName: z.string().trim().max(200).nullable().optional(),
    taxId: optionalPolishNipSchema,
    companyVerificationLevel: z.enum(["registry_verified", "provider_verified", "manual_unverified", "invalid"]).nullable().optional(),
    companyIdentitySource: z.string().trim().max(120).nullable().optional(),
    companyIdentityEvidenceHash: z.string().trim().max(160).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const customerBillingProfileDeleteRequestSchema = z.object({ idempotencyKey: idempotencyKeySchema, profileId: uuidSchema }).strict();

export const customerBillingProfilesResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_BILLING_CONTRACT_VERSION),
    ordererProfiles: z.array(customerOrdererProfileSchema),
  })
  .strict();

export const customerInvoiceCorrectionRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    invoiceId: uuidSchema,
    reason: z.string().trim().min(8).max(500),
    requestedFields: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    note: nullableTextSchema.optional(),
  })
  .strict();

export const customerInvoiceCorrectionResponseSchema = z.object({ contractVersion: z.literal(CUSTOMER_BILLING_CONTRACT_VERSION), eventId: uuidSchema }).strict();

export const customerAccountV2ResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION),
    profile: customerAccountProfileSchema,
    pets: z.array(customerAccountPetSchema),
    subscriptions: z.array(customerAccountV2SubscriptionSchema),
    addresses: z.array(customerAddressSchema),
    ordererProfiles: z.array(customerOrdererProfileSchema),
    billingProfiles: z.array(customerOrdererProfileSchema),
    paymentPreferences: z.array(customerPaymentPreferenceSchema),
    deliveryPreferences: z.array(customerDeliveryPreferenceSchema).default([]),
    recentOrders: z.array(customerOrderSummarySchema),
    events: z.array(customerAccountEventSchema),
    actionRequired: z.array(customerAccountActionRequiredSchema).default([]),
  })
  .strict();

export { customerAccountRequestSchema, customerAccountActionRequiredSchema };

export type CustomerAccountV2Response = z.infer<typeof customerAccountV2ResponseSchema>;
export type CustomerDeliveryAlignment = z.infer<typeof customerDeliveryAlignmentSchema>;
export type { CustomerAccountActionRequired } from "./accountActionRequiredContracts.js";
export type CustomerOrdersListRequest = z.infer<typeof customerOrdersListRequestSchema>;
export type CustomerOrdersListResponse = z.infer<typeof customerOrdersListResponseSchema>;
export type CustomerOrderDetailRequest = z.infer<typeof customerOrderDetailRequestSchema>;
export type CustomerOrderDetailResponse = z.infer<typeof customerOrderDetailResponseSchema>;
export type CustomerBillingProfileUpsertRequest = z.infer<typeof customerBillingProfileUpsertRequestSchema>;
export type CustomerBillingProfileDeleteRequest = z.infer<typeof customerBillingProfileDeleteRequestSchema>;
export type CustomerBillingProfilesResponse = z.infer<typeof customerBillingProfilesResponseSchema>;
export type CustomerInvoiceCorrectionRequest = z.infer<typeof customerInvoiceCorrectionRequestSchema>;
export type CustomerInvoiceCorrectionResponse = z.infer<typeof customerInvoiceCorrectionResponseSchema>;
