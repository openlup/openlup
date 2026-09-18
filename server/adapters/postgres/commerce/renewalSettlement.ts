import type {
  AutomaticRenewalSettlementPort,
} from "../../../domains/subscription/automaticRenewalPorts.js";
import type { PgQueryExecutor } from "../queryBuilder.js";

const PREPARE_SQL = `SELECT public.commerce_prepare_subscription_renewal(
  $1::uuid, $2::uuid, $3::timestamptz) AS response`;
const ACKNOWLEDGE_ATTEMPT_SQL = `SELECT public.commerce_acknowledge_subscription_renewal_attempt(
  $1::uuid, $2::text, $3::text, $4::timestamptz) AS response`;
const TERMINAL_SQL = `SELECT public.commerce_record_subscription_renewal_outcome(
  $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::timestamptz) AS response`;

/** Direct settlement persistence; terminal truth must arrive from an external acknowledgement. */
export function createPostgresRenewalSettlementPort(
  executor: PgQueryExecutor,
): AutomaticRenewalSettlementPort {
  return {
    async prepareRenewal(input) {
      const result = await executor.query(PREPARE_SQL, [
        input.operationId, input.claimToken, input.now,
      ]);
      const row = requiredRecord(record(result.rows[0])?.response, "prepare_response");
      if (row.contractVersion !== "platform.subscription.renewal.v1"
        || row.state !== "attempt_prepared") {
        throw new Error("subscription_renewal_prepare_response_invalid");
      }
      return {
        contractVersion: "platform.subscription.renewal.v1",
        replayed: row.replayed === true,
        operationId: requiredText(row.operationId, "operationId"),
        operationFingerprint: requiredText(row.operationFingerprint, "operationFingerprint"),
        cycleId: requiredText(row.cycleId, "cycleId"),
        orderId: requiredText(row.orderId, "orderId"),
        settlementIntentId: requiredText(row.settlementIntentId, "settlementIntentId"),
        state: "attempt_prepared",
      };
    },

    async acknowledgeExternalAttempt(input) {
      const externalAttemptRef = input.externalAttemptRef.trim();
      if (!externalAttemptRef) throw new Error("subscription_renewal_external_attempt_ref_required");
      const result = await executor.query(ACKNOWLEDGE_ATTEMPT_SQL, [
        input.operationId, input.operationFingerprint, externalAttemptRef, input.acknowledgedAt,
      ]);
      return requiredRecord(record(result.rows[0])?.response, "attempt_ack_response");
    },

    async recordTerminalOutcome(input) {
      if (input.outcome === "succeeded" && !input.externalRef?.trim()) {
        throw new Error("subscription_renewal_success_external_ref_required");
      }
      const result = await executor.query(TERMINAL_SQL, [
        input.operationId, input.eventKey, input.operationFingerprint, input.outcome,
        input.externalRef ?? null, input.reason ?? null, input.occurredAt,
      ]);
      return requiredRecord(record(result.rows[0])?.response, "terminal_response");
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw new Error(`subscription_renewal_${field}_invalid`);
  return result;
}
function requiredText(value: unknown, field: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`subscription_renewal_${field}_invalid`);
  return result;
}
