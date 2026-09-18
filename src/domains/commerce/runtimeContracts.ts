import {
  PAYMENT_FAILURE_CLASSES,
  PAYMENT_FAILURE_CLASSIFICATION_SOURCES,
} from "@openlup/core/payment";
import { z } from "../../lib/validation/zod.js";
import {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_EXECUTION_PROVIDERS,
  PAYMENT_INTENT_STATUSES,
  PAYMENT_PROVIDER_FLOWS,
} from "../payment/types.js";
import { OMS_FULFILLMENT_BLOCK_REASONS } from "./types.js";
import { checkoutPaymentExecutionSchema } from "./paymentExecutionContracts.js";
import {
  commerceCurrencySchema,
  commerceIdempotencyKeySchema,
  commerceMoneySchema,
  orderDraftSummarySchema,
} from "./contracts.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });

export const commerceRuntimeOrderModeSchema = z.enum(["one_time", "subscription_cycle"]);
export const commerceRuntimePaymentResultStatusSchema = z.enum([
  "succeeded",
  "failed",
  "expired",
  "refunded",
  "partially_refunded",
  "disputed",
]);

export const startHiddenCheckoutRuntimeRequestSchema = z
  .object({
    idempotencyKey: commerceIdempotencyKeySchema,
    orderDraft: orderDraftSummarySchema,
    mode: commerceRuntimeOrderModeSchema,
    clientId: uuidSchema,
    shippingAddressId: uuidSchema,
    petId: uuidSchema.nullable().optional(),
    paymentProvider: z.enum(PAYMENT_EXECUTION_PROVIDERS).default("hidden_rehearsal"),
    /**
     * Which payment attempt this is for the SAME order. `idempotencyKey` is
     * journey-stable — one journey, one pet/order/subscription across cart
     * edits — and that stability also pins the provider-attempt identity, so a
     * retry after a terminal decline (above all with a DIFFERENT provider)
     * collides with the dead attempt's prepare key instead of re-charging.
     * Bumping this mints a fresh attempt identity on the untouched order: the
     * declined order deliberately stays `pending_payment` and re-payable, so a
     * new order would leave a payable duplicate with a recovery email in flight.
     *
     * ⛔ NOT a mirror of the renewal path's `buildExecutionIdempotencyKey`: that
     * one always emits `:attempt:<N>` (here omitted at 0 to keep the historic
     * key byte-identical) and adds a second `:provider-seq:<N>` for an
     * operator-only repair counter. Positionally this is its `retryAttempt`,
     * never its `providerAttemptSequence`. Both: `docs/PAYMENT_IDEMPOTENCY.md`.
     */
    paymentAttemptSequence: z.number().int().min(0).max(50).optional(),
    /**
     * Payment provider flow hint passed to the execution adapter. Defaults to
     * `"one_time_payment"` so existing callers stay byte-identical. Wave D's
     * off-session renewal sets `"off_session_payment"`; Wave C's save-card UX
     * sets `"setup_reusable_method"`.
     */
    providerFlow: z.enum(PAYMENT_PROVIDER_FLOWS).default("one_time_payment"),
    /**
     * Server-only resolved provider method reference. Public checkout requests
     * carry only a local savedMethodId; the BFF resolves ownership before this
     * field reaches the runtime/adapter boundary.
     */
    paymentMethodRef: z.string().trim().min(1).max(512).optional(),
    paymentMethodAliasType: z.enum(["UID", "PAYID"]).optional(),
    paymentMethodRecurringModel: z.enum(["O", "M"]).optional(),
    /**
     * When true the execution adapter requests a reusable mandate
     * (Stripe `setup_future_usage='off_session'`) so subscription renewals can be
     * charged off-session. Set for `subscription_initial` checkouts. Optional so
     * one-time callers stay byte-identical (undefined is treated as false).
     */
    saveForFutureUse: z.boolean().optional(),
    /**
     * Buyer return context for redirect-based providers (left unnamed on purpose).
     * `"account"` routes the post-payment return to the in-shell
     * `/konto/zamowienie/status` terminal; absent / `"public"` keeps the
     * anonymous `/skomponuj-pakiet/platnosc` return so existing callers stay
     * byte-identical. Optional (not defaulted) so the inferred request type keeps
     * `returnContext` non-required for the many fixtures that omit it.
     */
    returnContext: z.enum(["public", "account"]).optional(),
    paymentExecution: checkoutPaymentExecutionSchema.optional(),
    /**
     * The bank the buyer said they hold, answered in checkout before entering a
     * code. A SCHEME fact, not an acquirer fact: which banks can register a
     * reusable mandate is a property of the payment scheme, and the acquirer in
     * front of it is replaceable. So this sits beside `paymentExecution` rather
     * than inside a provider-specific variant of it — it survives swapping the
     * acquirer, and it structurally cannot ride along into a provider request.
     *
     * ⛔ ADVISORY, never a gate. The answer can simply be wrong: picking one bank
     * and generating the code in another app is an ordinary mistake for anyone
     * with two accounts. The authoritative check stays the scheme's own refusal,
     * which rejects an incapable issuer in under a second and takes no money.
     * This value exists so a refusal can be attributed to an issuer afterwards,
     * which is what makes the offered roster correctable from evidence instead
     * of guesswork. Deliberately NOT validated against that roster — the roster
     * is the thing under measurement, so refusing values it does not list would
     * hide exactly the cases worth learning from.
     */
    declaredBankId: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).optional(),
    providerPayer: z
      .object({
        email: z.string().trim().email().max(160),
        name: z.string().trim().min(1).max(180),
        ip: z.string().trim().min(1).max(80).nullable().optional(),
        userAgent: z.string().trim().min(1).max(500).nullable().optional(),
      })
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  /**
   * Restored invariant. This refine shipped on every definition of the schema
   * until PR 2284 replaced the file wholesale and dropped it, leaving the
   * subscription-requires-pet rule stated only as a private compensating check
   * inside the one route that parses this schema.
   *
   * Deliberately unconditional — including for a request that carries the
   * neutral `metadata.checkoutCommandVersion` marker. The neutral seam never
   * reaches this schema: `executeCheckoutCommand` validates
   * `checkoutCommandV1Schema` and then hands the runtime port a typed literal
   * with `petId: null`, so nothing legitimate is rejected here. Honouring the
   * marker at this layer would instead hand any caller of the admin
   * runtime-start route a one-key bypass of the barrier.
   */
  .refine((request) => request.mode !== "subscription_cycle" || Boolean(request.petId), {
    message: "subscription checkout requires petId",
    path: ["petId"],
  });

/**
 * The refusal's class, plus which rule produced it. Additive and optional:
 * LOG-ONLY telemetry that nothing in the runtime branches on. Both members are
 * closed vocabularies rather than free text, so a caller of this boundary cannot
 * invent a class the persisted CHECK constraint would then have to reject.
 */
export const commerceRuntimeFailureClassificationSchema = z
  .object({
    failureClass: z.enum(PAYMENT_FAILURE_CLASSES),
    decidedBy: z.enum(PAYMENT_FAILURE_CLASSIFICATION_SOURCES),
  })
  .strict();

export const applyHiddenCheckoutPaymentResultRequestSchema = z
  .object({
    idempotencyKey: commerceIdempotencyKeySchema,
    orderId: uuidSchema,
    paymentIntentId: uuidSchema,
    paymentEventId: uuidSchema.nullable().optional(),
    resultStatus: commerceRuntimePaymentResultStatusSchema,
    occurredAt: datetimeSchema,
    failureReason: z.string().trim().min(1).max(240).nullable().optional(),
    failureClassification: commerceRuntimeFailureClassificationSchema.nullable().optional(),
  })
  .strict();

export const hiddenCheckoutRuntimeReservationSchema = z
  .object({
    reservationId: uuidSchema,
    reservationIds: z.array(uuidSchema),
    orderItemId: uuidSchema,
    skuId: uuidSchema,
    sku: z.string().trim().min(1),
    status: z.literal("reserved"),
    replayed: z.boolean(),
  })
  .strict();

export const hiddenCheckoutRuntimePaymentSchema = z
  .object({
    paymentIntentId: uuidSchema,
    paymentId: uuidSchema,
    paymentAttemptId: uuidSchema.nullable(),
    status: z.enum(PAYMENT_INTENT_STATUSES),
    attemptStatus: z.enum(PAYMENT_ATTEMPT_STATUSES).nullable(),
    provider: z.enum(PAYMENT_EXECUTION_PROVIDERS),
    providerAttemptId: z.string().trim().min(1).nullable().optional(),
    /**
     * Provider-issued client secret. Only populated when the adapter returned
     * one (Stripe PaymentIntent / SetupIntent). Always nullable — payment-control
     * never stores it; the FE consumes it once via Stripe Elements and discards.
     */
    providerClientSecret: z.string().min(1).nullable().optional(),
    providerRedirectUrl: z.string().url().nullable().optional(),
    providerNextActionKind: z.string().min(1).nullable().optional(),
    /**
     * The refusal was a capability statement, not a rejected attempt: the
     * payer's bank cannot register a reusable mandate, so retrying the SAME
     * method can never succeed. Checkout reads it to decide whether a decline
     * may be offered as an inline retry or must route to the instruction page
     * that sends the buyer back with a card.
     */
    declineMandateUnsupported: z.boolean().optional(),
    /**
     * Internal provenance for continuation issuance. Replay/readback and
     * rehearsal responses omit it.
     */
    continuationActionOrigin: z.literal("fresh_execution").nullable().optional(),
  })
  .strict();

export const hiddenCheckoutRuntimeReadinessSchema = z
  .object({
    omsEligibility: z
      .object({
        allowed: z.boolean(),
        reason: z.enum(OMS_FULFILLMENT_BLOCK_REASONS).nullable(),
      })
      .strict(),
    fulfillmentCreate: z
      .object({
        allowed: z.boolean(),
        reason: z.string().nullable(),
        omsReason: z.enum(OMS_FULFILLMENT_BLOCK_REASONS).nullable(),
      })
      .strict(),
  })
  .strict();

export const startHiddenCheckoutRuntimeResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
    runtime: z
      .object({
        orderId: uuidSchema,
        orderRef: z.string().regex(/^order_[a-z0-9-]+$/),
        mode: commerceRuntimeOrderModeSchema,
        clientId: uuidSchema,
        petId: uuidSchema.nullable(),
        shippingAddressId: uuidSchema,
        total: commerceMoneySchema,
        finalizedReplayed: z.boolean(),
        reservations: z.array(hiddenCheckoutRuntimeReservationSchema).min(1),
        payment: hiddenCheckoutRuntimePaymentSchema,
        readiness: hiddenCheckoutRuntimeReadinessSchema,
        nextAction: z
          .object({
            kind: z.literal("await_hidden_payment_result"),
            provider: z.enum(PAYMENT_EXECUTION_PROVIDERS),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const applyHiddenCheckoutPaymentResultResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
    paymentResult: z
      .object({
        paymentIntentId: uuidSchema,
        paymentAttemptId: uuidSchema,
        paymentId: uuidSchema,
        orderId: uuidSchema,
        status: commerceRuntimePaymentResultStatusSchema,
        kind: z.string().trim().min(1),
        replayed: z.boolean(),
      })
      .strict(),
    reservationRelease: z
      .object({
        attempted: z.boolean(),
        releasedCount: z.number().int().nonnegative(),
      })
      .strict(),
    readiness: hiddenCheckoutRuntimeReadinessSchema.nullable(),
  })
  .strict();

export type StartHiddenCheckoutRuntimeRequest = z.infer<
  typeof startHiddenCheckoutRuntimeRequestSchema
>;
export type StartHiddenCheckoutRuntimeResponse = z.infer<
  typeof startHiddenCheckoutRuntimeResponseSchema
>;
export type ApplyHiddenCheckoutPaymentResultRequest = z.infer<
  typeof applyHiddenCheckoutPaymentResultRequestSchema
>;
export type ApplyHiddenCheckoutPaymentResultResponse = z.infer<
  typeof applyHiddenCheckoutPaymentResultResponseSchema
>;
export type HiddenCheckoutRuntimeReservation = z.infer<
  typeof hiddenCheckoutRuntimeReservationSchema
>;
export type HiddenCheckoutRuntimeReadiness = z.infer<
  typeof hiddenCheckoutRuntimeReadinessSchema
>;
