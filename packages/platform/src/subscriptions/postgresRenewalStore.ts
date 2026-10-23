import type { RenewalDue, RenewalFrozenSnapshot, RenewalReadback, RenewalSchedule, RenewalStorePort } from "./contracts/renewal.js";

/** Transaction-bound executors may be supplied; no driver, environment or account is selected here. */
export interface SubscriptionQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
/** The host preserves its native wire snapshot, identity dialect and evidence-bound numbering. */
export interface NativeRenewalCodec {
  due(row: Record<string, unknown>): RenewalDue;
  freeze(row: Record<string, unknown>, schedule: RenewalSchedule): RenewalFrozenSnapshot;
  encode(snapshot: RenewalFrozenSnapshot): Record<string, unknown>;
  decode(snapshot: Record<string, unknown>): RenewalFrozenSnapshot;
  readback(row: Record<string, unknown>): RenewalReadback;
  identity(snapshot: RenewalFrozenSnapshot): string;
  fingerprint(snapshot: RenewalFrozenSnapshot): string;
}
const SNAPSHOT_SQL = `SELECT s.id AS subscription_id,s.client_id,s.next_cycle_at::text AS scheduled_at,t.*,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('lineOrdinal',l.line_ordinal,'sku',l.sku,'quantity',l.quantity,
 'unitAmountMinor',l.unit_amount_minor) ORDER BY l.line_ordinal) FROM public.subscription_renewal_term_lines l
 WHERE l.subscription_id=s.id),'[]'::jsonb) AS lines
 FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
 WHERE s.id=$1::uuid AND s.next_cycle_at=$2::timestamptz`;
export function subscriptionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("subscription_renewal_response_invalid");
  return value as Record<string, unknown>;
}
/** Native claim/prepare remain their original SQL transaction units. G23 is composed by the host. */
export function createPostgresRenewalStore(executor: SubscriptionQueryExecutor, codec: NativeRenewalCodec): RenewalStorePort {
  async function header(input: RenewalSchedule) {
    const result = await executor.query(SNAPSHOT_SQL, [input.subscriptionId, input.scheduledAt]);
    if (!result.rows[0]) throw new Error("subscription_renewal_snapshot_not_found");
    return result.rows[0];
  }
  async function response(sql: string, values: unknown[]) {
    return codec.readback(subscriptionRecord((await executor.query(sql, values)).rows[0]?.response));
  }
  return {
    transactions: { graph: "native", prepare: "cycle_order_items_settlement_reservation_attempt",
      outcome: "settlement_outcome_schedule_counter_reservation", recovery: "settlement_cycle_receipt_case_counter" },
    async listDue(limit, asOf) {
      const result = await executor.query(`SELECT due.*,due.scheduled_at::text AS scheduled_at
        FROM public.subscription_list_due_renewals($1::timestamptz,$2::integer) due`, [asOf, limit]);
      return result.rows.map(row => codec.due(row));
    },
    async buildCycleSnapshots(input) {
      const stored = await executor.query(`SELECT cycle_snapshot FROM public.subscription_renewal_operations
        WHERE subscription_id=$1::uuid AND scheduled_at=$2::timestamptz`, [input.subscriptionId, input.scheduledAt]);
      return stored.rows[0] ? codec.decode(subscriptionRecord(stored.rows[0].cycle_snapshot)) : codec.freeze(await header(input), input);
    },
    async readMandateEvidence(input) {
      const row = await header(input);
      return { authorized: true, authorizationRef: String(row.authorization_ref),
        authorizedAt: row.unattended_charge_authorized_at instanceof Date
          ? row.unattended_charge_authorized_at.toISOString() : String(row.unattended_charge_authorized_at) };
    },
    async admitDeliveryAlignment(input) {
      const row = await header(input);
      if (row.delivery_admission !== "allowed" && row.delivery_admission !== "blocked") throw new Error("subscription_renewal_delivery_admission_invalid");
      return row.delivery_admission === "allowed"
        ? { allowed: true, state: "static", reason: "allowed" }
        : { allowed: false, state: "static", reason: String(row.delivery_block_reason ?? "delivery_alignment_blocked"), deferred: false };
    },
    async claimDue(input) {
      return response(`SELECT public.subscription_claim_due_renewal($1::text,$2::text,$3::jsonb,$4::text,$5::integer,$6::timestamptz) AS response`,
        [codec.identity(input.snapshot), codec.fingerprint(input.snapshot), JSON.stringify(codec.encode(input.snapshot)), input.workerId, input.leaseSeconds ?? 300, input.now]);
    },
    async readRenewal(identityKey) {
      const value = (await executor.query("SELECT public.subscription_read_renewal($1::text) AS response", [identityKey])).rows[0]?.response;
      return value == null ? null : codec.readback(subscriptionRecord(value));
    },
    async refuseBeforePayment(input) {
      return response("SELECT public.subscription_refuse_renewal_preflight($1::uuid,$2::uuid,$3::text,$4::timestamptz) AS response",
        [input.operationId, input.claimToken, input.reason, input.occurredAt]);
    },
  };
}
