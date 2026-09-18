// The concrete half of the cycle charge-failure propagation: the four durable
// effects the neutral orchestration in
// `server/domains/subscription/propagateSubscriptionCycleChargeFailure.ts`
// declares, performed against a Supabase-shaped client.
//
// The split follows the same rule as the failure-class read beside it: the port
// CONTRACT stays in the domain, only this implementation lives here, and the
// domain-boundary ratchet counts every `from`/`rpc` under `server/domains`
// precisely so new concrete calls stop landing there.
//
// Nothing in this file decides policy. The retry ladder, the idempotency-key
// shapes, the stranded-customer marker and the fail-soft instant anchor all
// belong to the domain; this file only carries their arguments across the wire
// and reports back what the store said.

import type {
  CycleChargeFailurePropagationPort,
  CycleRetryState,
  DunningCaseOpenOutcome,
} from "../../../domains/subscription/propagateSubscriptionCycleChargeFailure.js";
import { applyPaymentResultRpc } from "../../../shared/applyPaymentResultRpc.js";
import { signalTerminalPaymentDecline } from "../../../shared/signalTerminalPaymentDecline.js";

export interface FailurePropagationSupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  from(table: string): FailurePropagationQueryBuilder;
}

interface FailurePropagationQueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

interface FailurePropagationQueryBuilder extends PromiseLike<FailurePropagationQueryResult> {
  select(columns: string): FailurePropagationQueryBuilder;
  eq(column: string, value: unknown): FailurePropagationQueryBuilder;
  maybeSingle(): PromiseLike<FailurePropagationQueryResult>;
}

export function createSupabaseCycleChargeFailurePropagationPort(
  client: FailurePropagationSupabaseClient,
): CycleChargeFailurePropagationPort {
  return {
    async recordBlockedPreflightAttempt(input): Promise<void> {
      const { error } = await client.rpc("commerce_payment_control_record_attempt", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_intent_id: input.paymentIntentId,
        p_provider: input.providerKind,
        p_provider_attempt_id: null,
        p_provider_session_id: null,
        p_attempt_status: "blocked_preflight",
        p_next_action_kind: null,
        p_request_payload: {
          providerIdempotencyKey: input.providerIdempotencyKey,
          providerRequestFingerprint: input.providerRequestFingerprint,
          providerFlow: "renewal_preflight",
          source: "subscription.renewal.cron.v0",
        },
        p_response_payload: {
          providerCall: false,
          reason: input.failureReason,
        },
      });
      if (error) {
        throw new Error(
          `commerce_payment_control_record_attempt failed: ${error.message ?? "unknown"}`,
        );
      }
    },

    async readDurableAttemptInstant(input): Promise<string | null> {
      try {
        const { data, error } = await client
          .from("commerce_payment_attempts")
          .select("created_at")
          .eq("payment_intent_id", input.paymentIntentId)
          .eq("idempotency_key", input.attemptIdempotencyKey)
          .maybeSingle();
        if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
        const createdAt = (data as Record<string, unknown>).created_at;
        return typeof createdAt === "string" && createdAt.length > 0 ? createdAt : null;
      } catch {
        return null;
      }
    },

    async applyFailedResult(input): Promise<{ replayed: boolean }> {
      const { data, error } = await applyPaymentResultRpc(client, {
        idempotencyKey: input.idempotencyKey,
        paymentIntentId: input.paymentIntentId,
        paymentEventId: null,
        resultStatus: "failed",
        occurredAt: input.occurredAt,
        failureReason: input.failureReason,
        failureClassification: input.failureClassification,
      });
      if (error) {
        throw new Error(
          `commerce_payment_control_apply_result failed: ${error.message ?? "unknown"}`,
        );
      }
      const replayed =
        (data as { paymentResult?: { replayed?: unknown } } | null)?.paymentResult?.replayed === true;
      // The renewal rail terminalises off-session refusals here. `resultStatus`
      // is not read from input because this port only ever applies `failed`.
      signalTerminalPaymentDecline({
        resultStatus: "failed",
        replayed,
        occurredAt: input.occurredAt,
        failureReason: input.failureReason,
        failureClassification: input.failureClassification,
        provider: null,
      });
      return { replayed };
    },

    async readCycleRetryState(cycleId): Promise<CycleRetryState> {
      const { data, error } = await client
        .from("subscription_cycles")
        .select("retry_attempt, next_retry_at")
        .eq("id", cycleId)
        .maybeSingle();
      if (error) {
        throw new Error(`subscription_cycles read failed: ${error.message ?? "unknown"}`);
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { retryAttempt: null, nextRetryAt: null, rowPresent: false };
      }
      const row = data as Record<string, unknown>;
      return {
        retryAttempt: typeof row.retry_attempt === "number" ? row.retry_attempt : null,
        nextRetryAt: typeof row.next_retry_at === "string" ? row.next_retry_at : null,
        // A row that was read answers for its own schedule, `null` included.
        rowPresent: true,
      };
    },

    async openDunningCase(input): Promise<DunningCaseOpenOutcome> {
      try {
        const { data, error } = await client.rpc("subscription_handle_payment_failure_dunning", {
          p_idempotency_key: input.idempotencyKey,
          p_cycle_id: input.cycleId,
          p_subscription_id: input.subscriptionId,
          p_order_id: input.orderUuid,
          p_payment_intent_id: input.paymentIntentId,
          p_retry_attempt: input.retryAttempt,
          p_next_retry_at: input.nextRetryAt,
          p_failure_reason: input.failureReason,
          p_occurred_at: input.occurredAt,
          p_failure_class: input.failureClass,
        });
        if (error) {
          return { status: "rejected", reason: error.message ?? "unknown", code: error.code };
        }
        return { status: "opened", caseId: readDunningCaseId(data) };
      } catch (thrown) {
        return {
          status: "unavailable",
          reason: thrown instanceof Error ? thrown.message : String(thrown),
        };
      }
    },
  };
}

function readDunningCaseId(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const body = (data as Record<string, unknown>).subscriptionDunning;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>).caseId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
