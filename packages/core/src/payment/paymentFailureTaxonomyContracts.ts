/**
 * The vocabulary a refused payment is classified into, and the retry decision
 * each class implies.
 *
 * The classes answer one question — *may this instrument be charged again, and
 * by whom* — and nothing else. They are deliberately not a copy of any acquirer's
 * code list: an adapter translates its own codes into the neutral evidence in
 * {@link PaymentFailureEvidence}, and only that evidence reaches this kernel.
 *
 * `indeterminate` means the CLASS is unknown, never that the OUTCOME is unknown.
 * A refusal whose money movement is itself ambiguous must be resolved by the
 * idempotency and attempt-fingerprint layer before anything here is consulted;
 * this kernel cannot make a repeat charge safe.
 */

/**
 * Ordered strongest-refusal-first. The order is documentation only — the
 * classifier resolves a class from evidence, never from this array's index.
 */
/** @beta */
export const PAYMENT_FAILURE_CLASSES = [
  /** The credential is dead or the refusal is final: lost, stolen, reported fraudulent, closed account, or an authorization the payer revoked. Another attempt cannot succeed and still costs scheme fees. */
  "hard_do_not_retry",
  /** The stored mandate, alias, or standing consent no longer works even though the instrument may. Re-registration or a replacement method is required; a scheduled retry against the same stored reference repeats the same refusal. */
  "mandate_dead",
  /** Strong authentication is required. A retry is only meaningful through an on-session or hosted confirmation the payer can answer; a blind background retry cannot clear it. */
  "sca_required",
  /** Submitted data is wrong: number, security code, expiry, or address. Never retry automatically — the same wrong data produces the same refusal and, repeated, looks like enumeration. */
  "fix_and_retry_customer_action",
  /** Retriable, but only after a longer wait: a velocity, frequency, or amount limit was exceeded and needs time to decay. */
  "soft_retry_delayed",
  /** Transient: insufficient funds, a processing error, an unreachable issuer, or an explicit try-again-later verdict. A scheduled retry is the correct response. */
  "soft_retryable",
  /** Unclassifiable from the evidence supplied. Treated as soft with the default schedule, which is the conservative choice only because the retry ladder is bounded elsewhere. */
  "indeterminate",
] as const;
/** @beta */
export type PaymentFailureClass = (typeof PAYMENT_FAILURE_CLASSES)[number];

/**
 * The retry verdict the network or issuer returned with the refusal. These three
 * values are scheme-standard advice, not one acquirer's vocabulary, which is why
 * a neutral kernel may name them.
 */
/** @beta */
export const PAYMENT_RETRY_ADVICE_CODES = [
  "do_not_try_again",
  "try_again_later",
  "confirm_card_data",
] as const;
/** @beta */
export type PaymentRetryAdviceCode = (typeof PAYMENT_RETRY_ADVICE_CODES)[number];

/**
 * Neutral assertions an adapter makes about a refusal it already understands.
 *
 * The array order IS the resolution order used when several hints are asserted
 * at once: the strictest reading wins, so a refusal that is both dead and merely
 * slow is never scheduled for a background retry.
 */
/** @beta */
export const PAYMENT_FAILURE_HINTS = [
  /** The instrument itself is finished: reported lost or stolen, flagged as fraud, closed, or the payer withdrew authorization. */
  "credentialDead",
  /** The payer's bank cannot honour the stored reusable reference, whatever the instrument's own state. */
  "mandateUnsupported",
  /** The refusal is an authentication demand, not a decline of the money. */
  "authenticationRequired",
  /** A submitted value was rejected as wrong rather than refused as unaffordable. */
  "dataInvalid",
  /** A velocity, frequency, or amount limit was hit; the same charge may pass once the limit decays. */
  "limitExceeded",
  /** An ordinary temporary refusal with no further detail. */
  "transient",
] as const;
/** @beta */
export type PaymentFailureHint = (typeof PAYMENT_FAILURE_HINTS)[number];

/**
 * Everything the kernel is allowed to look at. Every field is optional: an
 * adapter that knows nothing supplies nothing and gets `indeterminate`, which is
 * an honest answer rather than a guess.
 */
/** @beta */
export interface PaymentFailureEvidence {
  /** The issuer or network retry verdict, when one was returned. Recognized values are {@link PaymentRetryAdviceCode}; anything else is ignored rather than guessed at. */
  adviceCode?: string;
  /** The acquirer's own refusal code, kept opaque here. It contributes a class only through a caller-supplied hint table — this kernel embeds no code lists. */
  declineCode?: string;
  /** Neutral assertions the adapter is willing to make about the refusal. */
  neutralReasonHints?: readonly PaymentFailureHint[];
  /** The internal reason string already persisted with the attempt, if the failure travelled through the control plane before being classified. */
  failureReasonKey?: string;
}

/** What a retry is allowed to look like for a class. */
/** @beta */
export type PaymentRetryProfile = "standard" | "delayed" | "none" | "on_session_only";

/**
 * The consequence of a class, as data. This record does not schedule anything and
 * does not know the current ladder; it states what a scheduler is permitted to do.
 */
/** @beta */
export interface PaymentFailureDecision {
  retryAllowed: boolean;
  retryProfile: PaymentRetryProfile;
  customerActionRequired: boolean;
  methodReplacementRequired: boolean;
}

const DECISIONS: Readonly<Record<PaymentFailureClass, PaymentFailureDecision>> = Object.freeze({
  hard_do_not_retry: Object.freeze({
    retryAllowed: false,
    retryProfile: "none",
    customerActionRequired: true,
    methodReplacementRequired: true,
  }),
  mandate_dead: Object.freeze({
    retryAllowed: false,
    retryProfile: "none",
    customerActionRequired: true,
    methodReplacementRequired: true,
  }),
  sca_required: Object.freeze({
    retryAllowed: true,
    retryProfile: "on_session_only",
    customerActionRequired: true,
    methodReplacementRequired: false,
  }),
  fix_and_retry_customer_action: Object.freeze({
    retryAllowed: false,
    retryProfile: "none",
    customerActionRequired: true,
    methodReplacementRequired: false,
  }),
  soft_retry_delayed: Object.freeze({
    retryAllowed: true,
    retryProfile: "delayed",
    customerActionRequired: false,
    methodReplacementRequired: false,
  }),
  soft_retryable: Object.freeze({
    retryAllowed: true,
    retryProfile: "standard",
    customerActionRequired: false,
    methodReplacementRequired: false,
  }),
  indeterminate: Object.freeze({
    retryAllowed: true,
    retryProfile: "standard",
    customerActionRequired: false,
    methodReplacementRequired: false,
  }),
});

/**
 * The frozen decision for a class. Frozen so a consumer cannot quietly widen
 * `retryAllowed` for one call site and leave every other reader believing the
 * table still holds.
 */
/** @beta */
export function failureClassDecision(failureClass: PaymentFailureClass): PaymentFailureDecision {
  return DECISIONS[failureClass];
}

/**
 * What a payer can be TOLD about a refused or impossible charge.
 *
 * Coarser than {@link PAYMENT_FAILURE_CLASSES} on purpose: a payer acts on
 * remedies and there are fewer remedies than classes. Every class whose real
 * content is "we do not know why" collapses into `unknown`, which exists so a
 * caller can say nothing rather than guess — a surface rendering `unknown` must
 * render exactly what it rendered before consulting this vocabulary.
 *
 * `method_missing` is the one cause no class produces: it belongs to the
 * pre-renewal rails, which read a stored method that does not exist rather than a
 * refusal that happened. It lives here so both kinds of surface quote one
 * vocabulary instead of two.
 */
/** @beta */
export const PAYMENT_FAILURE_CUSTOMER_CAUSES = [
  /** Authentication is owed; the instrument may be fine, nobody was present. */
  "needs_confirmation",
  /** Stored consent cannot back an unattended charge, whatever the instrument. */
  "method_cannot_recur",
  /** The instrument is finished; another attempt on it cannot succeed. */
  "method_dead",
  /** Stored details rejected as wrong, not refused as unaffordable. */
  "method_data_invalid",
  /** No usable stored method. Pre-renewal state only, never a refusal. */
  "method_missing",
  /** Nothing may be claimed. Surfaces must add no sentence at all. */
  "unknown",
] as const;
/** @beta */
export type PaymentFailureCustomerCause = (typeof PAYMENT_FAILURE_CUSTOMER_CAUSES)[number];

const CUSTOMER_CAUSES: Readonly<Record<PaymentFailureClass, PaymentFailureCustomerCause>> =
  Object.freeze({
    hard_do_not_retry: "method_dead",
    mandate_dead: "method_cannot_recur",
    sca_required: "needs_confirmation",
    fix_and_retry_customer_action: "method_data_invalid",
    // The soft readings say only that a retry is allowed, which is not a cause
    // anybody can act on; `indeterminate` says outright that nothing is known.
    // Naming a cause here would invent an issuer verdict.
    soft_retry_delayed: "unknown",
    soft_retryable: "unknown",
    indeterminate: "unknown",
  });

/**
 * The cause a payer may be told, for a class that may not have been recorded.
 *
 * Takes `string | null` rather than {@link PaymentFailureClass} on purpose: the
 * caller reads a nullable column written by an older deployment, and an
 * unrecognized value must degrade to `unknown` exactly like a missing one.
 */
/** @beta */
export function customerCauseForFailureClass(
  failureClass: string | null | undefined,
): PaymentFailureCustomerCause {
  if (failureClass === null || failureClass === undefined) return "unknown";
  return Object.prototype.hasOwnProperty.call(CUSTOMER_CAUSES, failureClass)
    ? CUSTOMER_CAUSES[failureClass as PaymentFailureClass]
    : "unknown";
}
