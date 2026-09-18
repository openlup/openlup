import { z } from "../../lib/validation/zod.js";

export const SUBSCRIPTION_RUNTIME_CONTRACT_VERSION = "commerce.v0" as const;

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z.string().trim().min(8).max(180);
const paymentMethodRefSchema = z.string().trim().min(1).max(240);
const paymentMethodKindSchema = z.string().trim().min(1).max(80);

/**
 * Dunning recovery deep-link path, validated by **shape, not by market route**.
 *
 * The concrete route (`/konto/platnosc/napraw` today) is one deployment's
 * localized fulfilment surface, not a property of the subscription domain — just
 * as the delivery timetable is one operator's market config that
 * `deliveryEstimate` takes from the overlay rather than baking in. So this
 * kernel contract asserts only the invariants every deployment shares: an
 * absolute in-app path carrying the recovery token as a `?token=` query pair.
 * The route literal stays owned by the app/overlay (`routeMap.customerPaymentRecovery`)
 * and by the producing RPC, keeping this validated runtime contract locale-neutral.
 *
 * Shape: leading `/`, a non-empty path with no whitespace / query / fragment
 * chars, then exactly `?token=<64 lowercase hex>` and nothing after. This accepts
 * every currently-produced value byte-for-byte and keeps every prior structural
 * rejection (missing/short/upper/non-hex token, relative path, extra params,
 * fragment) — it only stops pinning the fixed market-specific path segment.
 */
const recoveryUrlPathSchema = z.string().regex(/^\/[^\s?#]+\?token=[a-f0-9]{64}$/);

export const activateSubscriptionFromPaidCheckoutOrderRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    orderId: uuidSchema,
    paymentIntentId: uuidSchema,
    paymentMethodRef: paymentMethodRefSchema,
    paymentMethodKind: paymentMethodKindSchema,
    paidAt: datetimeSchema,
  })
  .strict();

export const activateSubscriptionFromPaidCheckoutOrderResponseSchema = z
  .object({
    contractVersion: z.literal(SUBSCRIPTION_RUNTIME_CONTRACT_VERSION),
    subscriptionActivation: z
      .object({
        subscriptionId: uuidSchema,
        orderId: uuidSchema,
        paymentIntentId: uuidSchema,
        status: z.literal("active"),
        nextCycleAt: datetimeSchema,
        cadenceDays: z.number().int().positive(),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const handleSubscriptionPaymentFailureRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    cycleId: uuidSchema,
    subscriptionId: uuidSchema,
    orderId: uuidSchema,
    paymentIntentId: uuidSchema,
    retryAttempt: z.number().int().positive(),
    nextRetryAt: datetimeSchema.nullable().optional(),
    failureReason: z.string().trim().min(1).max(240).nullable().optional(),
    occurredAt: datetimeSchema,
  })
  .strict();

export const handleSubscriptionPaymentFailureResponseSchema = z
  .object({
    contractVersion: z.literal(SUBSCRIPTION_RUNTIME_CONTRACT_VERSION),
    subscriptionDunning: z
      .object({
        caseId: uuidSchema,
        subscriptionId: uuidSchema,
        cycleId: uuidSchema,
        orderId: uuidSchema,
        paymentIntentId: uuidSchema,
        status: z.enum(["open", "expired"]),
        retryAttempt: z.number().int().positive(),
        nextRetryAt: datetimeSchema.nullable(),
        customerNotificationQueued: z.boolean(),
        adminNotificationCount: z.number().int().nonnegative(),
        recoveryTokenPurpose: z.enum(["repair_payment", "resume_subscription"]),
        recoveryUrlPath: recoveryUrlPathSchema,
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const markSubscriptionDunningRecoveredRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    caseId: uuidSchema,
    paymentIntentId: uuidSchema,
    recoveredAt: datetimeSchema,
  })
  .strict();

export const markSubscriptionDunningRecoveredResponseSchema = z
  .object({
    contractVersion: z.literal(SUBSCRIPTION_RUNTIME_CONTRACT_VERSION),
    subscriptionDunningRecovery: z
      .object({
        caseId: uuidSchema,
        subscriptionId: uuidSchema,
        cycleId: uuidSchema,
        status: z.literal("recovered"),
        recoveredAt: datetimeSchema,
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const recordSubscriptionPaymentRecoveryRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    recoveryToken: z.string().trim().min(32).max(256),
    paymentMethodRef: paymentMethodRefSchema,
    paymentMethodKind: paymentMethodKindSchema,
    requestedAt: datetimeSchema,
  })
  .strict();

export const recordSubscriptionPaymentRecoveryResponseSchema = z
  .object({
    contractVersion: z.literal(SUBSCRIPTION_RUNTIME_CONTRACT_VERSION),
    subscriptionPaymentRecovery: z
      .object({
        caseId: uuidSchema,
        subscriptionId: uuidSchema,
        cycleId: uuidSchema,
        orderId: uuidSchema,
        purpose: z.enum(["repair_payment", "resume_subscription"]),
        nextAction: z.enum(["retry_existing_cycle", "resume_subscription"]),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const resumeSubscriptionFromExpiredDunningRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    recoveryToken: z.string().trim().min(32).max(256),
    paymentMethodRef: paymentMethodRefSchema,
    paymentMethodKind: paymentMethodKindSchema,
    cycleNumber: z.number().int().positive(),
    scheduledAt: datetimeSchema,
    templateSnapshot: z.record(z.string(), z.unknown()),
    pricingSnapshot: z.record(z.string(), z.unknown()),
    orderSnapshot: z.record(z.string(), z.unknown()),
    requestedAt: datetimeSchema,
  })
  .strict();

export const resumeSubscriptionFromExpiredDunningResponseSchema = z
  .object({
    contractVersion: z.literal(SUBSCRIPTION_RUNTIME_CONTRACT_VERSION),
    subscriptionDunningResume: z
      .object({
        caseId: uuidSchema,
        subscriptionId: uuidSchema,
        previousCycleId: uuidSchema,
        cycleOrder: z
          .object({
            subscriptionId: uuidSchema,
            cycleId: uuidSchema,
            cycleNumber: z.number().int().positive(),
            orderId: z.string().regex(/^order_[a-z0-9-]+$/),
            paymentId: z.string().regex(/^payment_[a-z0-9-]+$/),
            status: z.literal("payment_pending"),
            outboxEventType: z.literal("commerce.subscription_payment.requested"),
            idempotencyKey: z.string().trim().min(8),
            replayed: z.boolean(),
          })
          .strict(),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const runLocalReferenceRenewalTickRequestSchema = z.object({}).strict();

export const runLocalReferenceRenewalTickResponseSchema = z
  .object({
    contractVersion: z.literal(SUBSCRIPTION_RUNTIME_CONTRACT_VERSION),
    renewalTick: z
      .object({
        asOf: datetimeSchema,
        scanned: z.number().int().nonnegative(),
        startedRows: z.number().int().nonnegative(),
        deferredByBudget: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        results: z.array(
          z
            .object({
              subscriptionId: uuidSchema,
              outcome: z.enum(["charged", "requires_action", "failed", "skipped"]),
              cycleId: uuidSchema.nullable(),
              orderId: uuidSchema.nullable(),
              paymentIntentId: uuidSchema.nullable(),
              reason: z.string().nullable().optional(),
              dunningCaseId: uuidSchema.nullable(),
              retryAttempt: z.number().int().nonnegative().nullable(),
              replayed: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export type ActivateSubscriptionFromPaidCheckoutOrderRequest = z.infer<
  typeof activateSubscriptionFromPaidCheckoutOrderRequestSchema
>;
export type ActivateSubscriptionFromPaidCheckoutOrderResponse = z.infer<
  typeof activateSubscriptionFromPaidCheckoutOrderResponseSchema
>;
export type HandleSubscriptionPaymentFailureRequest = z.infer<
  typeof handleSubscriptionPaymentFailureRequestSchema
>;
export type HandleSubscriptionPaymentFailureResponse = z.infer<
  typeof handleSubscriptionPaymentFailureResponseSchema
>;
export type MarkSubscriptionDunningRecoveredRequest = z.infer<
  typeof markSubscriptionDunningRecoveredRequestSchema
>;
export type MarkSubscriptionDunningRecoveredResponse = z.infer<
  typeof markSubscriptionDunningRecoveredResponseSchema
>;
export type RecordSubscriptionPaymentRecoveryRequest = z.infer<
  typeof recordSubscriptionPaymentRecoveryRequestSchema
>;
export type RecordSubscriptionPaymentRecoveryResponse = z.infer<
  typeof recordSubscriptionPaymentRecoveryResponseSchema
>;
export type ResumeSubscriptionFromExpiredDunningRequest = z.infer<
  typeof resumeSubscriptionFromExpiredDunningRequestSchema
>;
export type ResumeSubscriptionFromExpiredDunningResponse = z.infer<
  typeof resumeSubscriptionFromExpiredDunningResponseSchema
>;
export type RunLocalReferenceRenewalTickRequest = z.infer<
  typeof runLocalReferenceRenewalTickRequestSchema
>;
export type RunLocalReferenceRenewalTickResponse = z.infer<
  typeof runLocalReferenceRenewalTickResponseSchema
>;
