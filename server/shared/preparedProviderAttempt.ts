import type {
  PaymentControlRuntimePort,
  PreparedProviderAttemptRuntimePort,
} from "../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionPort } from "../../src/domains/payment/ports.js";
import type {
  PaymentAttemptStatus,
  PaymentExecutionInput,
  PaymentExecutionProvider,
  PaymentExecutionResult,
} from "../../src/domains/payment/types.js";
import { finalizePreparedProviderAttempt } from "./preparedProviderAttemptFinalization.js";
import {
  providerAttemptDispatchFailure,
  type ProviderAttemptFailureDiagnostic,
  type ProviderAttemptFailurePhase,
} from "./providerAttemptFailureDiagnostic.js";

export function requiresPreparedProviderAttempt(
  provider: PaymentExecutionProvider,
): provider is Extract<PaymentExecutionProvider, "stripe" | "tpay"> {
  return provider === "stripe" || provider === "tpay";
}

export function preparedProviderAttemptPort(
  paymentPort: PaymentControlRuntimePort,
  provider: PaymentExecutionProvider,
  createUnavailableError?: (provider: PaymentExecutionProvider) => Error,
): PreparedProviderAttemptRuntimePort {
  const candidate = paymentPort as Partial<PreparedProviderAttemptRuntimePort>;
  if (
    typeof candidate.prepareProviderAttempt !== "function" ||
    typeof candidate.finalizeProviderAttempt !== "function"
  ) {
    throw createUnavailableError?.(provider) ??
      new Error(`payment_control_prepared_attempt_unavailable:${provider}`);
  }
  return candidate as PreparedProviderAttemptRuntimePort;
}

export interface DurableProviderAttemptResult {
  execution: PaymentExecutionResult;
  attempt: { paymentAttemptId: string; status: PaymentAttemptStatus };
}

export interface PreparedProviderAttemptReplay {
  paymentAttemptId: string;
  status: PaymentAttemptStatus;
  providerAttemptId: string | null;
  providerSessionId: string | null;
}

export interface TrustedProviderAttemptPreDispatchFailure {
  phase: "oauth" | "transaction_dispatch";
  code: "tpay_oauth_failed" | "tpay_oauth_timeout" | "tpay_oauth_invalid_response" | "tpay_request_encode_failed" | "tpay_request_deadline_exhausted";
  dispatchState: "not_dispatched";
}

/** Either proof the provider holds no transaction: the POST was never invoked, or it was and the
 * provider refused the request document. Two closed shapes, so neither absorbs the other. */
export type TrustedProviderAttemptNoChargeFailure = TrustedProviderAttemptPreDispatchFailure | { phase: "response_decode"; code: "tpay_request_refused"; dispatchState: "refused" };

export class ProviderAttemptInFlightError extends Error {
  readonly code = "provider_attempt_in_flight";
  readonly errorCode = "provider_attempt_in_flight";
  readonly paymentAttemptId: string;
  readonly attemptStatus: PaymentAttemptStatus;
  readonly phase = "transaction_dispatch" as const;
  readonly dispatchState = "unknown" as const;

  constructor(preparedAttempt: PreparedProviderAttemptReplay) {
    super(`provider_attempt_in_flight:${preparedAttempt.status}`);
    this.name = "ProviderAttemptInFlightError";
    this.paymentAttemptId = preparedAttempt.paymentAttemptId;
    this.attemptStatus = preparedAttempt.status;
  }
}

/** A PSP boundary proved the provider holds no transaction. `dispatchState` keeps the two grades
 * apart; neither may be inferred from silence, a timeout or a transport loss. The name predates the
 * second grade and is kept because it is the type every caller of this rail already branches on. */
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

/**
 * A durable attempt exists and a provider result may exist, but the local
 * control plane cannot yet prove its terminal state. Callers must preserve the
 * order/reservation and defer to reconciliation instead of compensating.
 */
export class ProviderAttemptDispatchUncertainError extends Error {
  readonly phase: ProviderAttemptFailurePhase;
  readonly errorCode: string;
  readonly dispatchState = "unknown" as const;
  readonly failureDiagnostic: ProviderAttemptFailureDiagnostic | null;
  paymentAttemptId: string | null = null;

  protected constructor(name: string, code: string, error: unknown, phase: ProviderAttemptFailurePhase) {
    const typedFailure = providerAttemptDispatchFailure(error);
    super(`${code}:${typedFailure?.code ?? safeErrorMessage(error)}`);
    this.name = name;
    this.phase = typedFailure?.phase ?? phase;
    this.errorCode = typedFailure?.code ?? code;
    this.failureDiagnostic = typedFailure?.failureDiagnostic ?? null;
  }

  withPaymentAttempt(paymentAttemptId: string): this {
    this.paymentAttemptId = paymentAttemptId;
    return this;
  }
}

export class ProviderAttemptExecutionError extends ProviderAttemptDispatchUncertainError {
  readonly code = "provider_execution_failed";

  constructor(error: unknown) {
    super("ProviderAttemptExecutionError", "provider_execution_failed", error, "transaction_dispatch");
  }
}

export class ProviderAttemptFinalizationError extends ProviderAttemptDispatchUncertainError {
  readonly code = "provider_finalization_failed";

  constructor(error: unknown) {
    super("ProviderAttemptFinalizationError", "provider_finalization_failed", error, "local_finalize");
  }
}

export class ProviderAttemptPostDispatchError extends ProviderAttemptDispatchUncertainError {
  readonly code = "provider_post_dispatch_failed";

  constructor(error: unknown) {
    super("ProviderAttemptPostDispatchError", "provider_post_dispatch_failed", error, "local_finalize");
  }
}

/**
 * Runs local work after a real PSP has acknowledged execution. Any later local
 * failure is ambiguous payment work too: a provider object may exist, so callers
 * must preserve the checkout aggregate until payment-control reconciliation.
 */
export async function preserveProviderDispatchUncertainty<T>(
  operation: () => Promise<T>,
  paymentAttemptId: string | null = null,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProviderAttemptDispatchUncertainError) {
      throw paymentAttemptId ? error.withPaymentAttempt(paymentAttemptId) : error;
    }
    const uncertain = new ProviderAttemptPostDispatchError(error);
    throw paymentAttemptId ? uncertain.withPaymentAttempt(paymentAttemptId) : uncertain;
  }
}

export async function executePreparedProviderAttempt(input: {
  paymentPort: PreparedProviderAttemptRuntimePort;
  executionPort: PaymentExecutionPort;
  provider: Extract<PaymentExecutionProvider, "stripe" | "tpay">;
  paymentIntentId: string;
  executionInput: PaymentExecutionInput;
  prepareIdempotencyKey: string;
  finalizeIdempotencyKey: string;
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
  providerFlow: string;
  paymentMethodRef?: string | null;
  prepareRequestPayload: Record<string, unknown>;
  validateExecution?: (execution: PaymentExecutionResult) => void;
  replayError?: (preparedAttempt: PreparedProviderAttemptReplay) => Error;
  executionError?: (error: unknown) => Error;
  finalizationError?: (error: unknown) => Error;
}): Promise<DurableProviderAttemptResult> {
  // Reject deterministic local input/config errors before persisting a durable
  // attempt. Only an actual PSP dispatch may create an indeterminate attempt.
  input.executionPort.validateInput?.(input.executionInput);

  const preparedAttempt = await input.paymentPort.prepareProviderAttempt({
    idempotencyKey: input.prepareIdempotencyKey,
    paymentIntentId: input.paymentIntentId,
    provider: input.provider,
    providerIdempotencyKey: input.providerIdempotencyKey,
    providerRequestFingerprint: input.providerRequestFingerprint,
    providerFlow: input.providerFlow,
    paymentMethodRef: input.paymentMethodRef ?? null,
    requestPayload: input.prepareRequestPayload,
  });

  if (preparedAttempt.replayed) {
    throw input.replayError?.(preparedAttempt) ?? new ProviderAttemptInFlightError(preparedAttempt);
  }

  let execution: PaymentExecutionResult;
  try {
    execution = await input.executionPort.execute(input.executionInput);
    input.validateExecution?.(execution);
  } catch (error) {
    if (error instanceof ProviderAttemptPreDispatchError) {
      logPreDispatchRetry(error, preparedAttempt.paymentAttemptId);
      try {
        execution = await input.executionPort.execute(input.executionInput);
        input.validateExecution?.(execution);
      } catch (retryError) {
        if (retryError instanceof ProviderAttemptPreDispatchError) {
          throw retryError
            .withPaymentAttempt(preparedAttempt.paymentAttemptId)
            .withRetryCount(error.retryCount + 1);
        }
        throw attachPaymentAttempt(
          input.executionError?.(retryError) ?? new ProviderAttemptExecutionError(retryError),
          preparedAttempt.paymentAttemptId,
        );
      }
    } else {
      throw attachPaymentAttempt(
        input.executionError?.(error) ?? new ProviderAttemptExecutionError(error),
        preparedAttempt.paymentAttemptId,
      );
    }
  }

  let finalizedAttempt: Awaited<ReturnType<PreparedProviderAttemptRuntimePort["finalizeProviderAttempt"]>>;
  try {
    const finalizeInput = {
      idempotencyKey: input.finalizeIdempotencyKey,
      paymentIntentId: input.paymentIntentId,
      paymentAttemptId: preparedAttempt.paymentAttemptId,
      providerIdempotencyKey: input.providerIdempotencyKey,
      providerRequestFingerprint: input.providerRequestFingerprint,
      providerAttemptId: execution.providerAttemptId,
      providerSessionId: execution.providerSessionId,
      attemptStatus: execution.attemptStatus,
      nextActionKind: execution.nextActionKind,
      requestPayload: execution.requestPayload,
      responsePayload: execution.responsePayload,
    };
    finalizedAttempt = await finalizePreparedProviderAttempt(
      () => input.paymentPort.finalizeProviderAttempt(finalizeInput),
    );
  } catch (error) {
    throw attachPaymentAttempt(
      input.finalizationError?.(error) ?? new ProviderAttemptFinalizationError(error),
      preparedAttempt.paymentAttemptId,
    );
  }

  return {
    execution,
    attempt: {
      paymentAttemptId: finalizedAttempt.paymentAttemptId,
      status: finalizedAttempt.status,
    },
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error);
  return text.trim() || "unknown";
}

function attachPaymentAttempt(error: Error, paymentAttemptId: string): Error {
  return error instanceof ProviderAttemptDispatchUncertainError ? error.withPaymentAttempt(paymentAttemptId) : error;
}

function logPreDispatchRetry(error: ProviderAttemptPreDispatchError, paymentAttemptId: string): void {
  console.error("provider_attempt_predispatch_retry", JSON.stringify({
    paymentAttemptId,
    phase: error.phase,
    code: error.code,
    dispatchState: error.dispatchState,
    retryOrdinal: error.retryCount + 1,
  }));
}
