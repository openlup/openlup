export interface TrustedProviderAttemptPreDispatchFailure {
  phase: "oauth" | "transaction_dispatch";
  code: "tpay_oauth_failed" | "tpay_oauth_timeout" | "tpay_oauth_invalid_response" | "tpay_request_encode_failed" | "tpay_request_deadline_exhausted";
  dispatchState: "not_dispatched";
}

/** Either proof the provider holds no transaction: the POST was never invoked, or it was and the
 * provider refused the request document. Two closed shapes, so neither absorbs the other. */
export type TrustedProviderAttemptNoChargeFailure = TrustedProviderAttemptPreDispatchFailure | { phase: "response_decode"; code: "tpay_request_refused"; dispatchState: "refused" };

export class ProviderAttemptPreDispatchError extends Error {
  readonly phase: TrustedProviderAttemptNoChargeFailure["phase"];
  readonly code: TrustedProviderAttemptNoChargeFailure["code"];
  readonly dispatchState: TrustedProviderAttemptNoChargeFailure["dispatchState"];
  paymentAttemptId: string | null;
  retryCount = 0;

  constructor(failure: TrustedProviderAttemptNoChargeFailure, paymentAttemptId: string | null = null) {
    const kind = failure.dispatchState === "refused" ? "provider_refused_pre_transaction" : "provider_pre_dispatch_failed";
    super(`${kind}:${failure.phase}:${failure.code}`);
    this.name = "ProviderAttemptPreDispatchError";
    this.phase = failure.phase;
    this.code = failure.code;
    this.dispatchState = failure.dispatchState;
    this.paymentAttemptId = paymentAttemptId;
  }

  withPaymentAttempt(paymentAttemptId: string): this {
    this.paymentAttemptId = paymentAttemptId;
    return this;
  }

  withRetryCount(retryCount: number): this {
    this.retryCount = retryCount;
    return this;
  }
}

