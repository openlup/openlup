import type { PaymentExecutionBaseInput, PaymentExecutionBaseResult } from "@openlup/core/payment";
import type {
  PreparedAttemptExecutionInput,
  PreparedAttemptExecutionResult,
  PreparedAttemptFailurePolicy,
  PreparedAttemptPersistenceResult,
} from "./contracts/preparedAttempt.js";
import { finalizePreparedProviderAttempt } from "./preparedAttemptFinalization.js";

/** Interactive ordering only; the caller binds nominal trust and native errors. */
export async function executePreparedAttemptMechanism<
  I extends PaymentExecutionBaseInput,
  R extends PaymentExecutionBaseResult & { nextActionKind: N | null },
  P extends string,
  N extends string,
  E extends Error,
>(
  input: PreparedAttemptExecutionInput<I, R, P, N>,
  policy: PreparedAttemptFailurePolicy<E, N>,
): Promise<PreparedAttemptExecutionResult<R>> {
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
    throw policy.replayError(preparedAttempt);
  }

  let execution: R;
  try {
    execution = await input.executionPort.execute(input.executionInput);
    input.validateExecution?.(execution);
  } catch (error) {
    if (policy.isTrustedNoCharge(error)) {
      policy.logRetry(error, preparedAttempt);
      try {
        execution = await input.executionPort.execute(input.executionInput);
        input.validateExecution?.(execution);
      } catch (retryError) {
        if (policy.isTrustedNoCharge(retryError)) {
          throw policy.exhaustedError(retryError, error, preparedAttempt);
        }
        throw policy.executionError(retryError, preparedAttempt);
      }
    } else {
      throw policy.executionError(error, preparedAttempt);
    }
  }

  let finalizedAttempt: PreparedAttemptPersistenceResult<N>;
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
    throw policy.finalizationError(error, preparedAttempt);
  }

  return {
    execution,
    attempt: {
      paymentAttemptId: finalizedAttempt.paymentAttemptId,
      status: finalizedAttempt.status,
    },
  };
}
