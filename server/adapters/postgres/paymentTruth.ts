import type {
  PaymentTruthPort,
  PaymentTruthReadback,
} from "../../domains/payment/paymentTruth.js";
import {
  paymentReconciliationFingerprint,
  paymentTruthFingerprint,
} from "../../domains/payment/paymentTruth.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const INGEST = `SELECT public.payment_truth_ingest_event(
  $1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) AS response`;
const RECONCILE = `SELECT public.payment_truth_record_reconciliation(
  $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) AS response`;
const SWEEP = "SELECT public.payment_truth_sweep_open_events($1,$2) AS response";
const READ = "SELECT public.payment_truth_readback($1::uuid,false) AS response";

export type PostgresPaymentTruthOptions = {
  dunningTemplateSlug: string;
  recoveryUrlPath: string;
  recoveryTemplateSlug: string;
};

/** Direct-PG caller for the provider-neutral payment truth public forward. */
export function createPostgresPaymentTruthPort(
  executor: PgQueryExecutor,
  options: PostgresPaymentTruthOptions,
): PaymentTruthPort {
  const dunningTemplateSlug = required(options.dunningTemplateSlug, "payment_truth_dunning_template_required");
  const recoveryUrlPath = required(options.recoveryUrlPath, "payment_truth_recovery_path_required");
  const recoveryTemplateSlug = required(options.recoveryTemplateSlug, "payment_truth_recovery_template_required");
  return {
    async ingestEvent(input) {
      const response = first(await executor.query(INGEST, [
        input.sourceEventId,
        paymentTruthFingerprint(input),
        input.idempotencyKey,
        input.settlementIntentId,
        input.outcome,
        input.amountMinor,
        input.currency,
        input.occurredAt,
        input.failure?.classification ?? null,
        input.failure?.reason ?? null,
        JSON.stringify(input.evidence),
        dunningTemplateSlug,
        recoveryUrlPath,
        recoveryTemplateSlug,
      ]));
      return readback(response?.response);
    },

    async recordReconciliation(input) {
      const response = first(await executor.query(RECONCILE, [
        input.eventId,
        input.idempotencyKey,
        paymentReconciliationFingerprint(input),
        input.evidenceStatus,
        input.outcome,
        input.occurredAt,
        input.failure?.classification ?? null,
        input.failure?.reason ?? null,
        JSON.stringify(input.evidence),
        dunningTemplateSlug,
        recoveryUrlPath,
        recoveryTemplateSlug,
      ]));
      return readback(response?.response);
    },

    async sweepOpenEvents(input) {
      const response = record(first(await executor.query(SWEEP, [input.now, input.limit]))?.response);
      return {
        claimed: integer(response.claimed),
        settledIgnored: integer(response.settledIgnored),
        eventIds: Array.isArray(response.eventIds)
          ? response.eventIds.filter((value): value is string => typeof value === "string")
          : [],
      };
    },

    async readEvent(eventId) {
      const value = first(await executor.query(READ, [eventId]))?.response;
      return value === null || value === undefined ? null : readback(value);
    },
  };
}

function readback(value: unknown): PaymentTruthReadback {
  const root = record(value);
  const event = record(root.event);
  const effects = record(root.effects);
  const financial = record(root.financial);
  const outcome = event.outcome;
  const state = event.state;
  if (
    typeof event.id !== "string"
    || typeof event.sourceEventId !== "string"
    || typeof event.fingerprint !== "string"
    || (state !== "open" && state !== "settled")
    || (outcome !== "captured" && outcome !== "refused" && outcome !== "indeterminate")
    || typeof event.replayed !== "boolean"
    || typeof effects.paymentResultRecorded !== "boolean"
    || typeof effects.dunningOpened !== "boolean"
    || typeof effects.accountingRequested !== "boolean"
    || !Number.isSafeInteger(financial.amountMinor)
    || typeof financial.currency !== "string"
  ) throw new Error("payment_truth_readback_invalid");
  return {
    event: {
      id: event.id,
      sourceEventId: event.sourceEventId,
      fingerprint: event.fingerprint,
      state,
      outcome,
      replayed: event.replayed,
    },
    effects: {
      paymentResultRecorded: effects.paymentResultRecorded,
      dunningOpened: effects.dunningOpened,
      accountingRequested: effects.accountingRequested,
    },
    financial: {
      settlementStatus: nullableString(financial.settlementStatus),
      orderStatus: nullableString(financial.orderStatus),
      subscriptionStatus: nullableString(financial.subscriptionStatus),
      accountingStatus: nullableString(financial.accountingStatus),
      amountMinor: financial.amountMinor as number,
      currency: financial.currency,
    },
  };
}

function first(result: { rows: Record<string, unknown>[] }): Record<string, unknown> | null {
  return result.rows[0] ?? null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function required(value: string, error: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(error);
  return trimmed;
}
