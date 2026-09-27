/**
 * The words and outcomes a card payment form exchanges with its host.
 *
 * The form itself is provider UI and lives with the provider adapters
 * (`src/checkout/adapters/stripe/`). What stays here is neutral: every word it
 * renders comes from its host, because `src/domains/payment` is a candidate
 * neutral kernel and must not reach into the application's translation
 * namespaces. The `load*` fields are the failure vocabulary for a provider
 * script that failed or never finished loading; they are optional so existing
 * callers keep compiling, and every in-repo host fills them from
 * `checkout:stripePay.*` or `account:completePayment.*`.
 */
export interface PaymentFormCopy {
  /** Host-translated approved guidance; supplied only by covered checkout callers. */
  recoveryMessage?: (key: string) => string;
  payButton: string;
  payingButton: string;
  errorPrefix: string;
  /** Shown when no publishable key is configured at all. */
  unavailable?: string;
  /** Shown while the payment fields are still painting. */
  loading?: string;
  /** Shown when the provider script failed or never finished loading. */
  loadFailed?: string;
  /** Label of the button that starts a fresh load attempt. */
  loadRetry?: string;
  /** Points the buyer at the payment methods that do not need this script. */
  loadAlternative?: string;
}

/** Browser confirmation outcome; `unknown` requires payment-control readback. */
export type PaymentFormSettlement = "succeeded" | "failed" | "unknown" | "retryable";

/** Host-supplied words of the form that replaces a failed payment method. */
export interface RecoveryPaymentSetupFormCopy {
  submitButton: string;
  submittingButton: string;
  errorPrefix: string;
}
