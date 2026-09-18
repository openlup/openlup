import type { PaymentAttemptStatus } from "./paymentControlTypes.js";
import type { PaymentFailureHint } from "./paymentFailureTaxonomyContracts.js";

/** @beta */
export const PAYMENT_EXECUTION_MODES = ["one_time", "subscription_cycle"] as const;
/** @beta */
export type PaymentExecutionMode = (typeof PAYMENT_EXECUTION_MODES)[number];

/** @beta */
export const PAYMENT_EXECUTION_ATTEMPT_STATUSES = [
  "sent_to_provider",
  "requires_action",
  "processing",
] as const satisfies readonly PaymentAttemptStatus[];
/** @beta */
export type PaymentExecutionAttemptStatus = Extract<
  PaymentAttemptStatus,
  (typeof PAYMENT_EXECUTION_ATTEMPT_STATUSES)[number]
>;

/** @beta */
export interface PaymentExecutionBaseInput {
  idempotencyKey: string;
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  mode: PaymentExecutionMode;
}

/**
 * A provider that refused the attempt inside the execution call itself, rather
 * than through a later callback.
 *
 * Execution adapters cannot express this as an attempt status: only the control
 * plane performs terminal transitions, so {@link PaymentExecutionAttemptStatus}
 * is deliberately non-terminal. The adapter therefore reports the refusal as a
 * fact and lets the caller finalize the attempt.
 *
 * Reporting it matters because some providers offer no second chance to learn of
 * the failure: where a provider's callback fires only for successful payments, a
 * synchronous decline that is not surfaced here is never reported at all, and
 * the attempt hangs until it expires.
 */
/** @beta */
export interface PaymentExecutionProviderDecline {
  /** Provider-native code, for correlation. Low-cardinality; never a free-form message. */
  code: string;
  /** True when the provider states the payer's bank cannot register a reusable mandate. */
  mandateUnsupported: boolean;
  /**
   * The finer refusal reason the payer's bank returned, when the provider passes
   * one through beside {@link code}. Optional because most providers report a
   * single code; still a code, never a message.
   */
  declineCode?: string;
  /**
   * The provider's machine-readable recommendation for what a retry should do
   * (for example: do not retry this instrument again). Optional and advisory —
   * nothing in the decline path branches on it yet; it is carried so a later
   * retry policy is not forced to re-query the provider for evidence that only
   * existed at refusal time.
   */
  adviceCode?: string;
  /**
   * What the adapter is willing to ASSERT about this refusal, already translated
   * out of its own code vocabulary into {@link PaymentFailureHint}.
   *
   * Carried on the decline so a classifier can read a refusal without learning
   * which adapter produced it: the acquirer's codes stop at the adapter that
   * owns them, and only the neutral reading crosses into the control plane.
   * Absent when the adapter has no opinion, which classifies as `indeterminate`
   * rather than as a guess.
   */
  neutralReasonHints?: readonly PaymentFailureHint[];
}

/** @beta */
export interface PaymentExecutionBaseResult {
  provider: string;
  providerAttemptId: string | null;
  providerSessionId: string | null;
  attemptStatus: PaymentExecutionAttemptStatus;
  nextActionKind: string | null;
  /**
   * Set when the provider refused synchronously. `null` for the normal path,
   * where the outcome arrives later via callback or polling.
   */
  providerDecline?: PaymentExecutionProviderDecline | null;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
}
