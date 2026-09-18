import type {
  AutomaticRenewalInventoryPort,
  AutomaticRenewalReservationResult,
} from "../../../domains/subscription/automaticRenewalPorts.js";
import type { PgQueryExecutor } from "../queryBuilder.js";

const RESERVE_SQL = `SELECT public.fulfillment_reserve_subscription_renewal(
  $1::uuid, $2::uuid, $3::integer, $4::timestamptz) AS response`;
const RELEASE_SQL = `SELECT public.fulfillment_release_subscription_renewal(
  $1::uuid, $2::uuid, $3::text, $4::timestamptz) AS response`;
const EXPIRE_SQL = `SELECT public.fulfillment_expire_subscription_renewals(
  $1::timestamptz, $2::integer) AS expired`;

/** ATP/reservation adapter; it can reserve only through the fenced public renewal function. */
export function createPostgresRenewalReservationPort(
  executor: PgQueryExecutor,
): AutomaticRenewalInventoryPort {
  return {
    async reserve(input) {
      const result = await executor.query(RESERVE_SQL, [
        input.operationId,
        input.claimToken,
        input.holdSeconds ?? 900,
        input.now,
      ]);
      const row = requiredRecord(record(result.rows[0])?.response, "reserve_response");
      const status = text(row.status) as AutomaticRenewalReservationResult["status"];
      if (!["held", "committed", "consumed", "released", "expired", "refused"].includes(status)) {
        throw new Error("subscription_renewal_reservation_status_invalid");
      }
      return {
        reserved: row.reserved === true,
        replayed: row.replayed === true,
        reservationId: nullableText(row.reservationId),
        status,
        reason: nullableText(row.reason),
      };
    },

    async releaseReservation(input) {
      const result = await executor.query(RELEASE_SQL, [
        input.operationId,
        input.claimToken,
        input.reason,
        input.now,
      ]);
      return requiredRecord(record(result.rows[0])?.response, "release_response");
    },

    async expireReservations(input) {
      const result = await executor.query(EXPIRE_SQL, [input.now, input.limit ?? 100]);
      const value = Number(record(result.rows[0])?.expired);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("subscription_renewal_expiry_response_invalid");
      }
      return value;
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw new Error(`subscription_renewal_${field}_invalid`);
  return result;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function nullableText(value: unknown): string | null { return text(value) || null; }
