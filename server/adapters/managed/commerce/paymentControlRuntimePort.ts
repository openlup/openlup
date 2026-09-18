import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
  type InteractivePreparedAttemptRuntimePort,
  type PreparedProviderAttemptRuntimePort,
} from "../../../../src/domains/commerce/runtimePorts.js";
import type { PaymentAttemptStatus, PaymentNextActionKind } from "../../../../src/domains/payment/types.js";
import { applyPaymentResultRpc } from "../../../shared/applyPaymentResultRpc.js";
import { signalTerminalPaymentDecline } from "../../../shared/signalTerminalPaymentDecline.js";
import { PROVIDER_ATTEMPT_PREPARE_IDEMPOTENCY_CONFLICT } from "../../../shared/providerAttemptFailureDiagnostic.js";

export interface ManagedPaymentControlClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function createManagedPaymentControlRuntimePort(
  client: ManagedPaymentControlClient,
): PreparedProviderAttemptRuntimePort & InteractivePreparedAttemptRuntimePort {
  return {
    async createIntent(input) {
      const { data, error } = await client.rpc("commerce_payment_control_create_intent", {
        p_idempotency_key: input.idempotencyKey,
        p_target_kind: input.targetKind,
        p_order_id: input.orderId,
        p_subscription_id: input.subscriptionId,
        p_subscription_cycle_id: input.subscriptionCycleId,
        p_amount_cents: input.amountMinor,
        p_currency: input.currency,
        p_metadata: input.metadata,
      });
      if (error) throw mapRpcError(error);
      const intent = readObject(data, "paymentIntent");
      return {
        paymentIntentId: readString(intent, "id"),
        paymentId: readString(intent, "paymentId"),
        status: readString(intent, "status") as "created",
        replayed: readBoolean(intent, "replayed"),
      };
    },

    async recordAttempt(input) {
      const { data, error } = await client.rpc("commerce_payment_control_record_attempt", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_intent_id: input.paymentIntentId,
        p_provider: input.provider,
        p_provider_attempt_id: input.providerAttemptId,
        p_provider_session_id: input.providerSessionId,
        p_attempt_status: input.attemptStatus,
        p_next_action_kind: input.nextActionKind,
        p_request_payload: input.requestPayload,
        p_response_payload: input.responsePayload,
      });
      if (error) throw mapRpcError(error);
      const attempt = readObject(data, "paymentAttempt");
      return {
        paymentAttemptId: readString(attempt, "id"),
        status: readString(attempt, "status") as PaymentAttemptStatus,
        replayed: readBoolean(attempt, "replayed"),
      };
    },

    async prepareProviderAttempt(input) {
      const { data, error } = await client.rpc("commerce_payment_control_prepare_provider_attempt", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_intent_id: input.paymentIntentId,
        p_provider: input.provider,
        p_provider_idempotency_key: input.providerIdempotencyKey,
        p_provider_request_fingerprint: input.providerRequestFingerprint,
        p_provider_flow: input.providerFlow,
        p_payment_method_ref: input.paymentMethodRef ?? null,
        p_request_payload: input.requestPayload,
      });
      if (error) throw mapRpcError(error);
      const admission = readOptionalObject(data, "paymentAttemptAdmission");
      if (admission?.reason === "payment_control_subscription_not_chargeable") {
        throw new CommerceRuntimeConflictError("Payment-control subscription not chargeable", {
          code: "55000",
          reason: "payment_control_subscription_not_chargeable",
        });
      }
      return readAttemptResult(data);
    },

    async finalizeProviderAttempt(input) {
      const { data, error } = await client.rpc("commerce_payment_control_finalize_provider_attempt", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_intent_id: input.paymentIntentId,
        p_payment_attempt_id: input.paymentAttemptId,
        p_provider_idempotency_key: input.providerIdempotencyKey,
        p_provider_request_fingerprint: input.providerRequestFingerprint,
        p_provider_attempt_id: input.providerAttemptId,
        p_provider_session_id: input.providerSessionId,
        p_attempt_status: input.attemptStatus,
        p_next_action_kind: input.nextActionKind,
        p_request_payload: input.requestPayload,
        p_response_payload: input.responsePayload,
      });
      if (error) throw mapRpcError(error);
      return readAttemptResult(data);
    },

    async applyResult(input) {
      const { data, error } = await applyPaymentResultRpc(client, {
        idempotencyKey: input.idempotencyKey,
        paymentIntentId: input.paymentIntentId,
        paymentEventId: input.paymentEventId ?? null,
        resultStatus: input.resultStatus,
        occurredAt: input.occurredAt,
        failureReason: input.failureReason ?? null,
        failureClassification: input.failureClassification ?? null,
      });
      if (error) throw mapRpcError(error);
      const result = readObject(data, "paymentResult");
      const replayed = readBoolean(result, "replayed");
      // The write landed; a refusal here is the interactive checkout rail's
      // only operator signal. This port receives no provider, so it says so.
      signalTerminalPaymentDecline({
        resultStatus: input.resultStatus,
        replayed,
        occurredAt: input.occurredAt,
        failureReason: input.failureReason ?? null,
        failureClassification: input.failureClassification ?? null,
        provider: null,
      });
      return {
        paymentIntentId: readString(result, "paymentIntentId"),
        paymentAttemptId: readString(result, "paymentAttemptId"),
        paymentId: readString(result, "paymentId"),
        orderId: readString(result, "orderId"),
        status: readString(result, "status") as typeof input.resultStatus,
        kind: readString(result, "kind"),
        replayed,
      };
    },

    async reopenInteractivePreparedAttempt(input) {
      const { data, error } = await client.rpc("commerce_payment_control_reopen_interactive_prepared_attempt", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_attempt_id: input.paymentAttemptId,
        p_expected_payment_intent_id: input.paymentIntentId,
        p_expected_order_id: input.expectedOrderId,
        p_expected_subscription_id: input.expectedSubscriptionId,
        p_expected_subscription_cycle_id: input.expectedSubscriptionCycleId,
        p_reopen_mode: input.evidence.mode,
        p_dispatch_state: input.evidence.dispatchState,
        p_phase: input.evidence.phase,
        p_reason_code: input.evidence.reasonCode,
        p_operator_ref: null,
        p_absence_checked_at: null,
        p_absence_evidence: {},
      });
      if (error) throw mapRpcError(error);
      const reopen = readObject(data, "interactivePreparedAttemptReopen");
      if (
        readString(reopen, "paymentAttemptStatus") !== "failed"
        || readString(reopen, "paymentIntentStatus") !== "failed"
      ) {
        throw new CommerceRuntimePersistenceError("Payment-control RPC response invalid");
      }
      return {
        paymentAttemptId: readString(reopen, "paymentAttemptId"),
        paymentIntentId: readString(reopen, "paymentIntentId"),
        paymentAttemptStatus: "failed" as const,
        paymentIntentStatus: "failed" as const,
        replayed: readBoolean(reopen, "replayed"),
      };
    },
  };
}

function readAttemptResult(data: unknown) {
  const attempt = readObject(data, "paymentAttempt");
  return {
    paymentAttemptId: readString(attempt, "id"),
    status: readString(attempt, "status") as PaymentAttemptStatus,
    replayed: readBoolean(attempt, "replayed"),
    providerAttemptId: readNullableString(attempt, "providerAttemptId"),
    providerSessionId: readNullableString(attempt, "providerSessionId"),
    nextActionKind: readNullableString(attempt, "nextActionKind") as PaymentNextActionKind | null,
  };
}

function readObject(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new CommerceRuntimePersistenceError("Payment-control RPC response invalid");
  }
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object") {
    throw new CommerceRuntimePersistenceError("Payment-control RPC response invalid");
  }
  return nested as Record<string, unknown>;
}

function readOptionalObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" ? nested as Record<string, unknown> : null;
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CommerceRuntimePersistenceError("Payment-control RPC response invalid");
  }
  return raw;
}

function readBoolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === true;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function mapRpcError(error: RpcError): Error {
  const values = [error.message, error.details, error.hint];
  const text = values.filter(Boolean).join(" ");
  if (values.some((value) => hasExactErrorName(value, PROVIDER_ATTEMPT_PREPARE_IDEMPOTENCY_CONFLICT))) {
    return new CommerceRuntimeConflictError("Payment-control prepare attempt idempotency conflict", {
      code: error.code,
      reason: PROVIDER_ATTEMPT_PREPARE_IDEMPOTENCY_CONFLICT,
    });
  }
  if (/payment_control_subscription_not_chargeable/.test(text)) {
    return new CommerceRuntimeConflictError("Payment-control subscription not chargeable", {
      code: error.code,
      reason: "payment_control_subscription_not_chargeable",
    });
  }
  if (
    error.code === "23505"
    || /payment_control_.*(?:conflict|invalid|mismatch|not_found|not_payable|retryable|terminal)/.test(text)
    || /interactive_prepared_attempt_reopen_/.test(text)
  ) {
    return new CommerceRuntimeConflictError("Payment-control runtime conflict", { code: error.code });
  }
  return new CommerceRuntimePersistenceError("Payment-control RPC failed", { code: error.code });
}

function hasExactErrorName(value: string | undefined, errorName: string): boolean {
  return value?.split(/[^a-z0-9_]+/).includes(errorName) ?? false;
}
