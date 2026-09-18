import {
  PAYMENT_FAILURE_HINTS,
  PAYMENT_RETRY_ADVICE_CODES,
  type PaymentFailureClass,
  type PaymentFailureEvidence,
  type PaymentFailureHint,
} from "./paymentFailureTaxonomyContracts.js";

/**
 * Pure classification of a refused payment into {@link PaymentFailureClass}.
 *
 * No clock, no input/output, no acquirer code tables: everything the verdict
 * depends on arrives in {@link PaymentFailureEvidence}, so the same evidence
 * always produces the same class and a test can enumerate the whole surface.
 *
 * Nothing consumes this yet. It is the contract the adapter mappings and the
 * cadence branching are written against, landed first and on its own so the
 * table can be reviewed as a table rather than as a diff inside a scheduler.
 */

/** Which rule produced the class. Published so a precedence conflict is assertable, not inferred from the class alone. */
/** @beta */
export const PAYMENT_FAILURE_CLASSIFICATION_SOURCES = [
  "advice_code",
  "neutral_hint",
  "failure_reason_key",
  "default",
] as const;
/** @beta */
export type PaymentFailureClassificationSource =
  (typeof PAYMENT_FAILURE_CLASSIFICATION_SOURCES)[number];

/** @beta */
export interface PaymentFailureClassification {
  failureClass: PaymentFailureClass;
  decidedBy: PaymentFailureClassificationSource;
}

/** @beta */
export interface PaymentFailureClassificationOptions {
  /**
   * The adapter's own translation from its opaque decline codes to neutral
   * hints. Supplied per call because the codes belong to the adapter, never to
   * this kernel. Keys are matched exactly, so the adapter owns normalization.
   */
  declineCodeHints?: Readonly<Record<string, readonly PaymentFailureHint[]>>;
}

const ADVICE_CLASSES: Readonly<Record<string, PaymentFailureClass>> = Object.freeze({
  do_not_try_again: "hard_do_not_retry",
  confirm_card_data: "fix_and_retry_customer_action",
  try_again_later: "soft_retryable",
});

const HINT_CLASSES: Readonly<Record<PaymentFailureHint, PaymentFailureClass>> = Object.freeze({
  credentialDead: "hard_do_not_retry",
  mandateUnsupported: "mandate_dead",
  authenticationRequired: "sca_required",
  dataInvalid: "fix_and_retry_customer_action",
  limitExceeded: "soft_retry_delayed",
  transient: "soft_retryable",
});

/**
 * The internal reason strings already persisted by the control plane.
 *
 * The `provider_*` four resolve to `indeterminate` on purpose: they record THAT
 * the charge failed and by which rail the news arrived, never WHY the issuer
 * refused. Mapping them to anything softer would invent a verdict that was never
 * returned. They are listed rather than left to the default so the absence of
 * information is pinned by a test instead of re-derived by each reader.
 *
 * The rest are renewal PREFLIGHT reasons: refusals reached on local evidence,
 * before any rail is asked. They belong here for the reason
 * `off_session_sca_required` does — the key IS the whole evidence, there is no
 * issuer verdict to defer to, and each states something about the stored method
 * rather than about one scheme's vocabulary.
 *
 * A key naming a specific scheme belongs to the adapter that owns it, which
 * asserts the matching neutral hint instead. Hence the vendor-prefixed preflight
 * reasons are absent: they resolve to `indeterminate` until that adapter maps
 * them, which is the honest answer rather than a kernel guess.
 */
const REASON_KEY_CLASSES: Readonly<Record<string, PaymentFailureClass>> = Object.freeze({
  off_session_sca_required: "sca_required",
  provider_declined: "indeterminate",
  provider_failed: "indeterminate",
  provider_webhook_failed: "indeterminate",
  provider_execution_indeterminate: "indeterminate",
  // Authorization withdrawn. The instrument may live on; this reference cannot
  // be charged.
  payment_method_revoked: "hard_do_not_retry",
  // Stored evidence says the payer must be present — an issuer's authentication
  // demand, reached one step earlier.
  payment_method_requires_action: "sca_required",
  // Nothing usable stored, or what is stored failed its integrity read. Both
  // need the payer to supply a method; neither is retriable as-is.
  missing_provider_method_ref: "fix_and_retry_customer_action",
  payment_method_invalid: "fix_and_retry_customer_action",
});

function ownValue<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function classified(
  failureClass: PaymentFailureClass,
  decidedBy: PaymentFailureClassificationSource,
): PaymentFailureClassification {
  return Object.freeze({ failureClass, decidedBy });
}

function assertedHints(
  evidence: PaymentFailureEvidence,
  options: PaymentFailureClassificationOptions,
): ReadonlySet<PaymentFailureHint> {
  const hints = new Set<PaymentFailureHint>(evidence.neutralReasonHints ?? []);
  for (const hint of ownValue(options.declineCodeHints ?? {}, evidence.declineCode) ?? []) {
    hints.add(hint);
  }
  return hints;
}

/**
 * Precedence, strongest first:
 *
 * 1. `adviceCode` — the issuer's or network's own retry verdict. It outranks
 *    every local reading because it is the only evidence produced by the party
 *    that will refuse the next attempt. An unrecognized value decides nothing
 *    and falls through rather than being coerced.
 * 2. neutral hints — what the adapter is willing to assert, whether stated
 *    directly or reached through its own decline-code table. Several hints at
 *    once resolve in {@link PAYMENT_FAILURE_HINTS} order, strictest first, so a
 *    refusal that is both dead and merely slow is never scheduled for a
 *    background retry.
 * 3. `failureReasonKey` — the reason already persisted with the attempt. Weakest
 *    because it is our own summary of a refusal, written before anyone tried to
 *    classify it.
 * 4. `indeterminate` — nothing decided.
 */
/** @beta */
export function classifyPaymentFailure(
  evidence: PaymentFailureEvidence,
  options: PaymentFailureClassificationOptions = {},
): PaymentFailureClassification {
  const advised = ownValue(ADVICE_CLASSES, evidence.adviceCode);
  if (advised !== undefined) return classified(advised, "advice_code");

  const hints = assertedHints(evidence, options);
  for (const hint of PAYMENT_FAILURE_HINTS) {
    if (hints.has(hint)) return classified(HINT_CLASSES[hint], "neutral_hint");
  }

  const byReason = ownValue(REASON_KEY_CLASSES, evidence.failureReasonKey);
  if (byReason !== undefined) return classified(byReason, "failure_reason_key");

  return classified("indeterminate", "default");
}

/** True when a value is one of the advice codes this kernel acts on. */
/** @beta */
export function isPaymentRetryAdviceCode(
  value: string,
): value is (typeof PAYMENT_RETRY_ADVICE_CODES)[number] {
  return (PAYMENT_RETRY_ADVICE_CODES as readonly string[]).includes(value);
}

/**
 * The hard ceiling any retry schedule must stay under: at most 15 attempts on one
 * instrument in 30 days. It is the stricter of the published card-scheme limits,
 * chosen deliberately so a schedule that satisfies this one satisfies all of them.
 *
 * The current ladder tops out at 4, far below this. The constant exists so a later
 * wave that widens the ladder has to measure itself against the scheme rule rather
 * than discover it through fines.
 */
/** @beta */
export const SCHEME_RETRY_ATTEMPT_CEILING = 15;

/** The rolling window the ceiling is counted over. */
/** @beta */
export const SCHEME_RETRY_WINDOW_DAYS = 30;

/**
 * Whether an attempt is provably inside the scheme ceiling.
 *
 * `attemptCount` is the ordinal of the attempt being considered — the 15th
 * attempt is inside, the 16th is not. `windowDays` is the span those attempts
 * were counted over; a span longer than {@link SCHEME_RETRY_WINDOW_DAYS} cannot
 * prove compliance, because the attempts may still cluster inside one 30-day
 * sub-window, so it answers false rather than pretending to know.
 *
 * Fail-closed for anything that is not a positive integer.
 */
/** @beta */
export function withinSchemeRetryCeiling(attemptCount: number, windowDays: number): boolean {
  if (!Number.isInteger(attemptCount) || !Number.isInteger(windowDays)) return false;
  if (attemptCount < 1 || windowDays < 1) return false;
  if (windowDays > SCHEME_RETRY_WINDOW_DAYS) return false;
  return attemptCount <= SCHEME_RETRY_ATTEMPT_CEILING;
}
