/**
 * Provider-neutral copy and settlement vocabulary exchanged between a browser
 * payment form adapter and its adopting host application.
 *
 * Every user-facing string is supplied by the host application so browser
 * payment adapters remain completely independent of host translation namespaces.
 */
export interface PaymentFormCopy {
  /** Host-translated approved guidance; supplied only by covered checkout callers. */
  recoveryMessage?: (key: string) => string;
  payButton: string;
  payingButton: string;
  errorPrefix: string;
  /** Shown when no browser-safe client configuration is available. */
  unavailable?: string;
  /** Shown while the payment fields are still mounting. */
  loading?: string;
  /** Shown when the provider script failed or never finished loading. */
  loadFailed?: string;
  /** Label of the button that starts a fresh load attempt. */
  loadRetry?: string;
  /** Points the buyer at payment methods that do not need this script. */
  loadAlternative?: string;
}

/** Browser confirmation outcome; `unknown` requires server payment-control readback. */
export type PaymentFormSettlement = "succeeded" | "failed" | "unknown" | "retryable";

/** Host-supplied copy for a browser form that replaces a failed payment method. */
export interface RecoveryPaymentSetupFormCopy {
  submitButton: string;
  submittingButton: string;
  errorPrefix: string;
}
