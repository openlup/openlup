import type {
  PaymentAttemptStatus,
  PaymentExecutionBaseInput,
  PaymentExecutionBaseResult,
} from "@openlup/core/payment";

/** Durable preparation facts; provider admission belongs to the caller. */
export interface PreparedAttemptPrepareInput<P extends string = string> {
  idempotencyKey: string;
  paymentIntentId: string;
  provider: P;
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
  providerFlow: string;
  paymentMethodRef?: string | null;
  requestPayload: Record<string, unknown>;
}

export interface PreparedAttemptPersistenceResult<N extends string = string> {
  paymentAttemptId: string;
  status: PaymentAttemptStatus;
  replayed: boolean;
  providerAttemptId: string | null;
  providerSessionId: string | null;
  nextActionKind: N | null;
}

export interface PreparedAttemptFinalizeInput<N extends string = string> extends Pick<
  PaymentExecutionBaseResult,
  "providerAttemptId" | "providerSessionId" | "attemptStatus" | "requestPayload" | "responsePayload"
> {
  idempotencyKey: string;
  paymentIntentId: string;
  paymentAttemptId: string;
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
  nextActionKind: N | null;
}

/** Only persistence capabilities needed by interactive attempt ordering. */
export interface PreparedAttemptPersistencePort<P extends string = string, N extends string = string> {
  prepareProviderAttempt(input: PreparedAttemptPrepareInput<P>): Promise<PreparedAttemptPersistenceResult<N>>;
  finalizeProviderAttempt(input: PreparedAttemptFinalizeInput<N>): Promise<PreparedAttemptPersistenceResult<N>>;
}

export interface PreparedAttemptExecutionPort<I extends PaymentExecutionBaseInput, R extends PaymentExecutionBaseResult> {
  validateInput?(input: I): void;
  execute(input: I): Promise<R>;
}

/** Exact execution extensions and original input/port references cross this seam. */
export interface PreparedAttemptExecutionInput<
  I extends PaymentExecutionBaseInput,
  R extends PaymentExecutionBaseResult,
  P extends string,
  N extends string,
> {
  paymentPort: PreparedAttemptPersistencePort<P, N>;
  executionPort: PreparedAttemptExecutionPort<I, R>;
  provider: P;
  paymentIntentId: string;
  executionInput: I;
  prepareIdempotencyKey: string;
  finalizeIdempotencyKey: string;
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
  providerFlow: string;
  paymentMethodRef?: string | null;
  prepareRequestPayload: Record<string, unknown>;
  validateExecution?: (execution: R) => void;
}

/** Synchronous, call-scoped native trust, diagnostics and error construction. */
export interface PreparedAttemptFailurePolicy<E extends Error, N extends string> {
  replayError(prepared: PreparedAttemptPersistenceResult<N>): Error;
  isTrustedNoCharge(error: unknown): error is E;
  logRetry(error: E, prepared: PreparedAttemptPersistenceResult<N>): void;
  exhaustedError(error: E, first: E, prepared: PreparedAttemptPersistenceResult<N>): E;
  executionError(error: unknown, prepared: PreparedAttemptPersistenceResult<N>): Error;
  finalizationError(error: unknown, prepared: PreparedAttemptPersistenceResult<N>): Error;
}

export interface PreparedAttemptExecutionResult<R extends PaymentExecutionBaseResult> {
  execution: R;
  attempt: { paymentAttemptId: string; status: PaymentAttemptStatus };
}
