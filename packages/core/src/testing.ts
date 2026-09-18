import {
  PAYMENT_EXECUTION_ATTEMPT_STATUSES,
  type PaymentExecutionBaseInput,
  type PaymentExecutionBaseResult,
} from "./payment/index.js";

/** @internal */
export type { PaymentExecutionBaseInput } from "./payment/index.js";

/** @internal */
export const neutralBrandFixture = {
  displayName: "Example Store",
  publicOrigin: "https://example.test",
} as const;

/** @internal */
export const paymentExecutionBaseContractInput = {
  idempotencyKey: "checkout-contract:payment-execution",
  providerIdempotencyKey: "contract:example-pay:payment-intent-contract:checkout-payment-execution",
  providerRequestFingerprint: "example-pay|payment-intent-contract|4200|USD|one_time|order_contract",
  paymentIntentId: "11111111-1111-4111-8111-111111111111",
  amountMinor: 4200,
  currency: "USD",
  mode: "one_time",
} satisfies PaymentExecutionBaseInput;

/** @internal */
export type PaymentExecutionContractResult = PaymentExecutionBaseResult & {
  rawProviderPayload?: Record<string, unknown> | null;
};

/** @internal */
export type PaymentExecutionContractValidationIssueCode =
  | "provider_mismatch"
  | "invalid_provider_attempt_id"
  | "invalid_provider_session_id"
  | "invalid_attempt_status"
  | "invalid_next_action_kind"
  | "invalid_request_payload"
  | "invalid_response_payload"
  | "missing_provider_idempotency_key"
  | "missing_provider_request_fingerprint"
  | "sensitive_value_leaked";

/** @internal */
export interface PaymentExecutionContractValidationIssue {
  code: PaymentExecutionContractValidationIssueCode;
  message: string;
  path: string;
}

/** @internal */
export type PaymentExecutionContractValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: PaymentExecutionContractValidationIssue[] };

/** @internal */
export interface PaymentExecutionContractValidationInput<
  TInput extends PaymentExecutionBaseInput = PaymentExecutionBaseInput,
  TResult extends PaymentExecutionContractResult = PaymentExecutionContractResult,
> {
  input: TInput;
  result: TResult;
  expectedProvider: string;
  allowedNextActionKinds?: readonly string[];
  sensitiveValues?: readonly string[];
}

/** @internal */
export function validatePaymentExecutionContractResult<
  TInput extends PaymentExecutionBaseInput = PaymentExecutionBaseInput,
  TResult extends PaymentExecutionContractResult = PaymentExecutionContractResult,
>(
  context: PaymentExecutionContractValidationInput<TInput, TResult>,
): PaymentExecutionContractValidationResult {
  const issues: PaymentExecutionContractValidationIssue[] = [];
  const { input, result } = context;

  if (result.provider !== context.expectedProvider) {
    issues.push({
      code: "provider_mismatch",
      path: "provider",
      message: `Expected provider ${context.expectedProvider}.`,
    });
  }
  if (result.providerAttemptId !== null && typeof result.providerAttemptId !== "string") {
    issues.push({
      code: "invalid_provider_attempt_id",
      path: "providerAttemptId",
      message: "Expected providerAttemptId to be null or a string.",
    });
  }
  if (result.providerSessionId !== null && typeof result.providerSessionId !== "string") {
    issues.push({
      code: "invalid_provider_session_id",
      path: "providerSessionId",
      message: "Expected providerSessionId to be null or a string.",
    });
  }
  if (!PAYMENT_EXECUTION_ATTEMPT_STATUSES.includes(result.attemptStatus)) {
    issues.push({
      code: "invalid_attempt_status",
      path: "attemptStatus",
      message: "Expected attemptStatus to be a provider-execution attempt status.",
    });
  }
  if (
    result.nextActionKind !== null
    && !(context.allowedNextActionKinds ?? []).includes(result.nextActionKind)
  ) {
    issues.push({
      code: "invalid_next_action_kind",
      path: "nextActionKind",
      message: "Expected nextActionKind to be null or listed in allowedNextActionKinds.",
    });
  }

  if (!isRecordPayload(result.requestPayload)) {
    issues.push({
      code: "invalid_request_payload",
      path: "requestPayload",
      message: "Expected requestPayload to be a non-array object.",
    });
  } else {
    if (result.requestPayload.providerIdempotencyKey !== input.providerIdempotencyKey) {
      issues.push({
        code: "missing_provider_idempotency_key",
        path: "requestPayload.providerIdempotencyKey",
        message: "Expected requestPayload to persist providerIdempotencyKey.",
      });
    }
    if (result.requestPayload.providerRequestFingerprint !== input.providerRequestFingerprint) {
      issues.push({
        code: "missing_provider_request_fingerprint",
        path: "requestPayload.providerRequestFingerprint",
        message: "Expected requestPayload to persist providerRequestFingerprint.",
      });
    }
  }

  if (!isRecordPayload(result.responsePayload)) {
    issues.push({
      code: "invalid_response_payload",
      path: "responsePayload",
      message: "Expected responsePayload to be a non-array object.",
    });
  }

  const persistedPayloadJson = JSON.stringify({
    requestPayload: result.requestPayload,
    responsePayload: result.responsePayload,
    rawProviderPayload: result.rawProviderPayload ?? null,
  });
  for (const sensitiveValue of context.sensitiveValues ?? []) {
    if (persistedPayloadJson.includes(sensitiveValue)) {
      issues.push({
        code: "sensitive_value_leaked",
        path: "requestPayload|responsePayload|rawProviderPayload",
        message: "Expected persisted provider payloads not to contain sensitive values.",
      });
    }
  }

  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

function isRecordPayload(payload: unknown): payload is Record<string, unknown> {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}
