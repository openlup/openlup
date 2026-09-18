import { createHash } from "node:crypto";

import type {
  AutomaticRenewalCycleSnapshot,
  AutomaticRenewalDue,
  AutomaticRenewalReadback,
  AutomaticRenewalStorePort,
} from "../../../domains/subscription/automaticRenewalPorts.js";
import type { PgQueryExecutor } from "../queryBuilder.js";

const LIST_DUE_SQL = `SELECT due.*, due.scheduled_at::text AS scheduled_at
  FROM public.subscription_list_due_renewals($1::timestamptz, $2::integer) due`;
const SNAPSHOT_SQL = `SELECT subscription.id AS subscription_id, subscription.client_id,
    subscription.next_cycle_at::text AS scheduled_at, terms.next_cycle_number AS cycle_number,
    terms.currency_code, terms.stock_source_key, terms.settlement_channel_key,
    terms.authorization_ref, terms.payer_account_ref, terms.unattended_charge_authorized_at,
    terms.delivery_admission, terms.delivery_block_reason,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'lineOrdinal', line.line_ordinal, 'sku', line.sku, 'quantity', line.quantity,
      'unitAmountMinor', line.unit_amount_minor) ORDER BY line.line_ordinal)
      FROM public.subscription_renewal_term_lines line
      WHERE line.subscription_id = subscription.id), '[]'::jsonb) AS lines
  FROM public.subscriptions subscription
  JOIN public.subscription_renewal_terms terms ON terms.subscription_id = subscription.id
  WHERE subscription.id = $1::uuid AND subscription.next_cycle_at = $2::timestamptz`;
const CLAIM_SQL = `SELECT public.subscription_claim_due_renewal(
  $1::text, $2::text, $3::jsonb, $4::text, $5::integer, $6::timestamptz) AS response`;
const READ_SQL = `SELECT public.subscription_read_renewal($1::text) AS response`;

/** Direct node-postgres persistence for the public automatic-renewal operation root. */
export function createPostgresAutomaticRenewalPort(
  executor: PgQueryExecutor,
): AutomaticRenewalStorePort {
  async function buildCycleSnapshots(input: {
    subscriptionId: string;
    scheduledAt: string;
  }): Promise<AutomaticRenewalCycleSnapshot> {
    const headerResult = await executor.query(SNAPSHOT_SQL, [input.subscriptionId, input.scheduledAt]);
    const header = record(headerResult.rows[0]);
    if (!header) throw new Error("subscription_renewal_snapshot_not_found");
    const lines = array(header.lines, "lines").map((value) => {
      const row = requiredRecord(value, "line");
      return {
        lineOrdinal: positiveInteger(row.lineOrdinal, "line_ordinal"),
        sku: requiredText(row.sku, "sku"),
        quantity: positiveInteger(row.quantity, "quantity"),
        unitAmountMinor: nonnegativeInteger(row.unitAmountMinor, "unit_amount_minor"),
      };
    });
    if (lines.length === 0) throw new Error("subscription_renewal_snapshot_lines_missing");
    const scheduledAt = requiredText(header.scheduled_at, "scheduled_at");
    const snapshot: AutomaticRenewalCycleSnapshot = {
      contractVersion: "platform.subscription.renewal.v1",
      subscriptionId: requiredText(header.subscription_id, "subscription_id"),
      clientId: requiredText(header.client_id, "client_id"),
      scheduledAt,
      cycleNumber: positiveInteger(header.cycle_number, "cycle_number"),
      currency: requiredText(header.currency_code, "currency_code"),
      totalAmountMinor: lines.reduce(
        (sum, line) => sum + line.quantity * line.unitAmountMinor,
        0,
      ),
      stockSourceKey: requiredText(header.stock_source_key, "stock_source_key"),
      settlementChannelKey: requiredText(header.settlement_channel_key, "settlement_channel_key"),
      authorizationRef: requiredText(header.authorization_ref, "authorization_ref"),
      payerAccountRef: nullableText(header.payer_account_ref),
      lines,
    };
    if (snapshot.totalAmountMinor < 1) throw new Error("subscription_renewal_snapshot_total_invalid");
    return snapshot;
  }

  return {
    async listDue(limit, asOf) {
      const result = await executor.query(LIST_DUE_SQL, [asOf, limit]);
      return result.rows.map(mapDue);
    },

    buildCycleSnapshots,

    async readMandateEvidence(input) {
      const result = await executor.query(SNAPSHOT_SQL, [input.subscriptionId, input.scheduledAt]);
      const row = record(result.rows[0]);
      if (!row) throw new Error("subscription_renewal_authorization_not_found");
      return {
        authorized: true,
        authorizationRef: requiredText(row.authorization_ref, "authorization_ref"),
        authorizedAt: timestamp(row.unattended_charge_authorized_at, "unattended_charge_authorized_at"),
      };
    },

    async admitDeliveryAlignment(input) {
      const result = await executor.query(SNAPSHOT_SQL, [input.subscriptionId, input.scheduledAt]);
      const row = record(result.rows[0]);
      if (!row) throw new Error("subscription_renewal_delivery_admission_not_found");
      const admission = requiredText(row.delivery_admission, "delivery_admission");
      if (admission !== "allowed" && admission !== "blocked") {
        throw new Error("subscription_renewal_delivery_admission_invalid");
      }
      return {
        allowed: admission === "allowed",
        reason: nullableText(row.delivery_block_reason),
      };
    },

    async claimDue(input) {
      const identityKey = automaticRenewalIdentity(
        input.snapshot.subscriptionId,
        input.snapshot.scheduledAt,
      );
      const operationFingerprint = automaticRenewalFingerprint(input.snapshot);
      const result = await executor.query(CLAIM_SQL, [
        identityKey,
        operationFingerprint,
        JSON.stringify(input.snapshot),
        input.workerId,
        input.leaseSeconds ?? 300,
        input.now,
      ]);
      return mapReadback(record(result.rows[0])?.response);
    },

    async readRenewal(identityKey) {
      const result = await executor.query(READ_SQL, [identityKey]);
      const value = record(result.rows[0])?.response;
      return value === null || value === undefined ? null : mapReadback(value);
    },

    async refuseBeforePayment(input) {
      const result = await executor.query(
        `SELECT public.subscription_refuse_renewal_preflight(
          $1::uuid, $2::uuid, $3::text, $4::timestamptz) AS response`,
        [input.operationId, input.claimToken, input.reason, input.occurredAt],
      );
      return mapReadback(record(result.rows[0])?.response);
    },
  };
}

export function automaticRenewalIdentity(subscriptionId: string, scheduledAt: string): string {
  return `subscription:${subscriptionId}:cycle:${new Date(scheduledAt).toISOString()}`;
}

export function automaticRenewalFingerprint(snapshot: AutomaticRenewalCycleSnapshot): string {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function mapDue(value: unknown): AutomaticRenewalDue {
  const row = requiredRecord(value, "due");
  const deliveryAdmission = requiredText(row.delivery_admission, "delivery_admission");
  if (deliveryAdmission !== "allowed" && deliveryAdmission !== "blocked") {
    throw new Error("subscription_renewal_due_invalid_delivery_admission");
  }
  return {
    subscriptionId: requiredText(row.subscription_id, "subscription_id"),
    clientId: requiredText(row.client_id, "client_id"),
    scheduledAt: requiredText(row.scheduled_at, "scheduled_at"),
    cadenceDays: positiveInteger(row.cadence_days, "cadence_days"),
    cycleNumber: positiveInteger(row.cycle_number, "cycle_number"),
    currency: requiredText(row.currency_code, "currency_code"),
    stockSourceKey: requiredText(row.stock_source_key, "stock_source_key"),
    settlementChannelKey: requiredText(row.settlement_channel_key, "settlement_channel_key"),
    authorizationRef: requiredText(row.authorization_ref, "authorization_ref"),
    payerAccountRef: nullableText(row.payer_account_ref),
    unattendedChargeAuthorizedAt: timestamp(
      row.unattended_charge_authorized_at,
      "unattended_charge_authorized_at",
    ),
    deliveryAdmission,
    deliveryBlockReason: nullableText(row.delivery_block_reason),
  };
}

function mapReadback(value: unknown): AutomaticRenewalReadback {
  const row = requiredRecord(value, "renewal_readback");
  const state = requiredText(row.state, "state") as AutomaticRenewalReadback["state"];
  if (!["claimed", "reserved", "attempt_prepared", "succeeded", "refused"].includes(state)) {
    throw new Error("subscription_renewal_readback_state_invalid");
  }
  const terminal = nullableText(row.terminalOutcome);
  if (terminal !== null && terminal !== "succeeded" && terminal !== "refused") {
    throw new Error("subscription_renewal_readback_terminal_invalid");
  }
  return {
    contractVersion: "platform.subscription.renewal.v1",
    acquired: row.acquired === true,
    replayed: row.replayed === true,
    reason: requiredText(row.reason, "reason"),
    operationId: requiredText(row.operationId, "operationId"),
    identityKey: requiredText(row.identityKey, "identityKey"),
    operationFingerprint: requiredText(row.operationFingerprint, "operationFingerprint"),
    subscriptionId: requiredText(row.subscriptionId, "subscriptionId"),
    scheduledAt: timestamp(row.scheduledAt, "scheduledAt"),
    cycleNumber: positiveInteger(row.cycleNumber, "cycleNumber"),
    state,
    claimToken: requiredText(row.claimToken, "claimToken"),
    claimGeneration: positiveInteger(row.claimGeneration, "claimGeneration"),
    leaseExpiresAt: timestamp(row.leaseExpiresAt, "leaseExpiresAt"),
    cycleSnapshot: requiredRecord(row.cycleSnapshot, "cycleSnapshot") as unknown as AutomaticRenewalCycleSnapshot,
    externalAttemptRef: nullableText(row.externalAttemptRef),
    externalAttemptAcknowledgedAt: nullableTimestamp(row.externalAttemptAcknowledgedAt),
    terminalOutcome: terminal as AutomaticRenewalReadback["terminalOutcome"],
    terminalReason: nullableText(row.terminalReason),
    terminalAt: nullableTimestamp(row.terminalAt),
    reservationId: nullableText(row.reservationId),
    cycleId: nullableText(row.cycleId),
    orderId: nullableText(row.orderId),
    settlementIntentId: nullableText(row.settlementIntentId),
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
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`subscription_renewal_${field}_invalid`);
  return value;
}
function requiredText(value: unknown, field: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`subscription_renewal_${field}_invalid`);
  return result;
}
function nullableText(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
}
function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}
function positiveInteger(value: unknown, field: string): number {
  const result = integer(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`subscription_renewal_${field}_invalid`);
  }
  return result;
}
function nonnegativeInteger(value: unknown, field: string): number {
  const result = integer(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`subscription_renewal_${field}_invalid`);
  }
  return result;
}
function timestamp(value: unknown, field: string): string {
  const result = value instanceof Date ? value.toISOString() : typeof value === "string"
    ? new Date(value).toISOString()
    : "";
  if (!result) throw new Error(`subscription_renewal_${field}_invalid`);
  return result;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value, "timestamp");
}
