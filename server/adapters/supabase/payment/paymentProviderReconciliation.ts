import type {
  ClaimedPaymentAttempt,
  InteractivePreparedAttemptManualReconciliationPort,
  InteractivePreparedAttemptReopenResult,
  PaymentProviderReconciliationPort,
  ReconciliationProviderKind,
} from "../../../domains/payment/paymentProviderReconciliationContracts.js";
import { signalTerminalPaymentDecline } from "../../../shared/signalTerminalPaymentDecline.js";

export interface PaymentProviderReconciliationSupabaseClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function createSupabasePaymentProviderReconciliationPort(
  client: PaymentProviderReconciliationSupabaseClient,
): PaymentProviderReconciliationPort & InteractivePreparedAttemptManualReconciliationPort {
  return {
    async claimPreparedAttempts(input) {
      const { data, error } = await client.rpc("commerce_payment_reconciliation_claim_prepared_attempts", {
        p_now: input.now,
        p_stale_after_seconds: input.staleAfterSeconds,
        p_limit: input.limit,
        p_claim_key: input.claimKey,
      });
      if (error) throw new Error(`commerce_payment_reconciliation_claim_prepared_attempts: ${readError(error)}`);
      if (!Array.isArray(data)) throw new Error("commerce_payment_reconciliation_claim_prepared_attempts: invalid response");
      return data.map(mapClaimedPreparedAttempt);
    },

    async claimStaleAttempts(input) {
      const { data, error } = await client.rpc("commerce_payment_reconciliation_claim_stale_attempts", {
        p_now: input.now,
        p_stale_after_seconds: input.staleAfterSeconds,
        p_limit: input.limit,
        p_claim_key: input.claimKey,
      });
      if (error) throw new Error(`commerce_payment_reconciliation_claim_stale_attempts: ${readError(error)}`);
      if (!Array.isArray(data)) throw new Error("commerce_payment_reconciliation_claim_stale_attempts: invalid response");
      return data.map(mapClaimedAttempt);
    },

    async recordEvidence(input) {
      const { data, error } = await client.rpc("commerce_payment_control_record_reconciliation", {
        p_idempotency_key: input.idempotencyKey,
        p_provider: input.provider,
        p_provider_payment_id: input.providerPaymentId,
        p_payment_intent_id: input.paymentIntentId,
        p_payment_attempt_id: input.paymentAttemptId,
        p_local_status: input.localStatus,
        p_provider_status: input.providerStatus,
        p_correction_status: input.correctionStatus,
        p_checked_at: input.checkedAt,
        p_payload: input.payload,
      });
      if (error) throw new Error(`commerce_payment_control_record_reconciliation: ${readError(error)}`);
      readObject(data, "paymentReconciliation");
      return { replayed: false };
    },

    async applyTerminalResult(input) {
      const { data, error } = await client.rpc("commerce_payment_control_apply_reconciliation_result", {
        p_idempotency_key: input.idempotencyKey,
        p_expected_order_id: input.expectedOrderId,
        p_expected_payment_intent_id: input.expectedPaymentIntentId,
        p_expected_payment_attempt_id: input.expectedPaymentAttemptId,
        p_expected_payment_id: input.expectedPaymentId,
        p_provider: input.provider,
        p_provider_payment_id: input.providerPaymentId,
        p_local_status: input.localStatus,
        p_provider_status: input.providerStatus,
        p_result_status: input.resultStatus,
        p_occurred_at: input.occurredAt,
        p_failure_reason: input.failureReason,
        p_checked_at: input.checkedAt,
        p_payload: input.payload,
        p_failure_class: input.failureClassification?.failureClass ?? null,
        p_failure_class_decided_by: input.failureClassification?.decidedBy ?? null,
      });
      if (error) throw new Error(`commerce_payment_control_apply_reconciliation_result: ${readError(error)}`);
      const body = readObject(data, "paymentReconciliationApply");
      const paymentResult = readObject(body, "paymentResult");
      const correctionStatus = readString(body, "correctionStatus");
      if (correctionStatus !== "corrected" && correctionStatus !== "ignored") {
        throw new Error("paymentReconciliationApply: invalid correction status");
      }
      const rawDunning = body.subscriptionWebhookDunning;
      const subscriptionWebhookDunning = rawDunning === null || rawDunning === undefined
        ? null
        : mapSubscriptionWebhookDunning(rawDunning);
      const replayed = readBoolean(body, "replayed");
      // The polling family: reconciliation cron, verify-now, and recovery-pay all
      // terminalise through this one port method. `ignored` means the control
      // plane declined the correction, so it is not a new transition either.
      // This is the ONLY seam that is handed a provider, so it is the only one
      // that reports a real name.
      signalTerminalPaymentDecline({
        resultStatus: input.resultStatus,
        replayed: replayed || correctionStatus !== "corrected",
        occurredAt: input.occurredAt,
        failureReason: input.failureReason,
        failureClassification: input.failureClassification ?? null,
        provider: input.provider,
      });
      return {
        replayed,
        paymentResult: {
          paymentIntentId: readString(paymentResult, "paymentIntentId"),
          paymentAttemptId: readString(paymentResult, "paymentAttemptId"),
          paymentId: readString(paymentResult, "paymentId"),
          orderId: readString(paymentResult, "orderId"),
          status: readString(paymentResult, "status"),
          kind: readString(paymentResult, "kind"),
          replayed: readBoolean(paymentResult, "replayed"),
        },
        correctionStatus,
        subscriptionWebhookDunning,
      };
    },

    async reopenPreparedAttemptAfterAbsence(input) {
      const { data, error } = await client.rpc("commerce_payment_control_reopen_prepared_attempt_after_absence", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_attempt_id: input.paymentAttemptId,
        p_expected_payment_intent_id: input.expectedPaymentIntentId,
        p_expected_subscription_cycle_id: input.expectedSubscriptionCycleId,
        p_operator_ref: input.operatorRef,
        p_absence_checked_at: input.absenceCheckedAt,
        p_next_retry_at: input.nextRetryAt,
        p_absence_evidence: input.absenceEvidence,
      });
      if (error) {
        throw new Error(`commerce_payment_control_reopen_prepared_attempt_after_absence: ${readError(error)}`);
      }
      const body = readObject(data, "preparedAttemptReopen");
      return { replayed: body.replayed === true };
    },

    async reopenInteractivePreparedAttemptAfterAbsence(input) {
      const { data, error } = await client.rpc("commerce_payment_control_reopen_interactive_prepared_attempt", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_attempt_id: input.paymentAttemptId,
        p_expected_payment_intent_id: input.expectedPaymentIntentId,
        p_expected_order_id: input.expectedOrderId,
        p_expected_subscription_id: input.expectedSubscriptionId,
        p_expected_subscription_cycle_id: input.expectedSubscriptionCycleId,
        p_reopen_mode: "manual_provider_absence",
        p_dispatch_state: "provider_absence_confirmed",
        p_phase: "operator_reconciliation",
        p_reason_code: input.absenceEvidence.evidenceCode,
        p_operator_ref: input.operatorRef,
        p_absence_checked_at: input.absenceCheckedAt,
        p_absence_evidence: input.absenceEvidence,
      });
      if (error) {
        throw new Error(`commerce_payment_control_reopen_interactive_prepared_attempt: ${readError(error)}`);
      }
      return readInteractivePreparedAttemptReopen(data);
    },
  };
}

function readInteractivePreparedAttemptReopen(data: unknown): InteractivePreparedAttemptReopenResult {
  const body = readObject(data, "interactivePreparedAttemptReopen");
  if (
    readString(body, "paymentAttemptStatus") !== "failed"
    || readString(body, "paymentIntentStatus") !== "failed"
  ) {
    throw new Error("interactivePreparedAttemptReopen: invalid terminal status");
  }
  return {
    paymentAttemptId: readString(body, "paymentAttemptId"),
    paymentIntentId: readString(body, "paymentIntentId"),
    paymentAttemptStatus: "failed",
    paymentIntentStatus: "failed",
    replayed: readBoolean(body, "replayed"),
  };
}

function mapSubscriptionWebhookDunning(value: unknown): {
  opened: boolean;
  replayed: boolean;
  caseId: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("subscriptionWebhookDunning: invalid response");
  }
  const body = value as Record<string, unknown>;
  return {
    opened: readBoolean(body, "opened"),
    replayed: readBoolean(body, "replayed"),
    caseId: readNullableString(body, "caseId"),
  };
}

function mapClaimedAttempt(value: unknown): ClaimedPaymentAttempt {
  return mapClaimedAttemptRow(value, "commerce_payment_reconciliation_claim_stale_attempts", true);
}

function mapClaimedPreparedAttempt(value: unknown): ClaimedPaymentAttempt {
  return mapClaimedAttemptRow(value, "commerce_payment_reconciliation_claim_prepared_attempts", false);
}

function mapClaimedAttemptRow(value: unknown, rpcName: string, requireProviderPaymentId: boolean): ClaimedPaymentAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${rpcName}: invalid row`);
  }
  const row = value as Record<string, unknown>;
  const provider = readString(row, "provider");
  if (provider !== "stripe" && provider !== "tpay") {
    throw new Error(`${rpcName}: unsupported provider`);
  }
  const orderMode = readString(row, "order_mode");
  const subscriptionId = readNullableString(row, "subscription_id");
  const subscriptionCycleId = readNullableString(row, "subscription_cycle_id");
  const hasSubscriptionContext = orderMode === "subscription_cycle" && subscriptionId !== null && subscriptionCycleId !== null;
  const hasOneTimeContext = orderMode === "one_time" && subscriptionId === null && subscriptionCycleId === null;
  if (!hasSubscriptionContext && !hasOneTimeContext) {
    throw new Error(`${rpcName}: invalid payment context`);
  }
  return {
    paymentAttemptId: readString(row, "payment_attempt_id"),
    paymentIntentId: readString(row, "payment_intent_id"),
    paymentId: readString(row, "payment_id"),
    orderId: readString(row, "order_id"),
    subscriptionId,
    subscriptionCycleId,
    provider: provider as ReconciliationProviderKind,
    providerPaymentId: requireProviderPaymentId
      ? readString(row, "provider_payment_id")
      : readNullableString(row, "provider_payment_id"),
    providerAttemptId: readNullableString(row, "provider_attempt_id"),
    providerSessionId: readNullableString(row, "provider_session_id"),
    attemptStatus: readString(row, "attempt_status"),
    intentStatus: readString(row, "intent_status"),
    amountMinor: readNumber(row, "amount_cents"),
    currency: readString(row, "currency"),
    orderMode: orderMode as ClaimedPaymentAttempt["orderMode"],
    cycleRetryAttempt: readNumber(row, "cycle_retry_attempt"),
    cycleNextRetryAt: readNullableString(row, "cycle_next_retry_at"),
    localUpdatedAt: readString(row, "local_updated_at"),
  };
}

function readObject(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key}: invalid response`);
  }
  const body = (value as Record<string, unknown>)[key];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${key}: invalid response`);
  }
  return body as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`Missing string ${key}`);
  return raw;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const raw = value[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`Missing number ${key}`);
  return raw;
}

function readBoolean(value: Record<string, unknown>, key: string): boolean {
  const raw = value[key];
  if (typeof raw !== "boolean") throw new Error(`Missing boolean ${key}`);
  return raw;
}

function readError(error: RpcError): string {
  return [error.message, error.details, error.hint, error.code].filter(Boolean).join(" ") || "failed";
}
