import type { RenewalDue, RenewalFrozenSnapshot, RenewalReadback, RenewalSchedule, RenewalStorePort } from "./contracts/renewal.js";
import { graduateNativeRenewal, nativeRetainedTerms } from "./nativeRenewalTerms.js";

/** Transaction-bound executors may be supplied; no driver, environment or account is selected here. */
export interface SubscriptionQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
/** Custom dialects remain injectable; createNativeRenewalCodec supplies the purchase lineage dialect. */
export interface NativeRenewalCodec {
  due(row: Record<string, unknown>): RenewalDue;
  freeze(row: Record<string, unknown>, schedule: RenewalSchedule): RenewalFrozenSnapshot;
  encode(snapshot: RenewalFrozenSnapshot): Record<string, unknown>;
  decode(snapshot: Record<string, unknown>): RenewalFrozenSnapshot;
  readback(row: Record<string, unknown>): RenewalReadback;
  identity(snapshot: RenewalFrozenSnapshot): string;
  fingerprint(snapshot: RenewalFrozenSnapshot): string;
  /** Native destination authority binds the final frozen document under the claim lock. */
  withDestination?(snapshot: RenewalFrozenSnapshot, destinationId: string): RenewalFrozenSnapshot;
}
export const subscriptionCorrelationSql = `o.subscription_cycle_id AS activation_cycle_id,
 ac.status='paid' AS activation_cycle_paid,
 (SELECT count(*)::integer FROM public.subscription_cycles pc
  WHERE pc.subscription_id=s.id AND pc.status='paid' AND pc.scheduled_at<s.next_cycle_at) AS paid_cycle_count`;
export const subscriptionCorrelationJoin = `LEFT JOIN public.subscription_activations a ON a.subscription_id=s.id
 LEFT JOIN public.commerce_orders o ON o.id=a.order_id
 LEFT JOIN public.subscription_cycles ac ON ac.id=o.subscription_cycle_id`;
const SNAPSHOT_SQL = `SELECT s.id AS subscription_id,s.client_id,s.cadence_days,s.template_version,to_char(s.next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS scheduled_at,t.*,
 to_char(t.unattended_charge_authorized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS unattended_charge_authorized_at,
 ${subscriptionCorrelationSql},m.health_state,public.subscription_renewal_purchase_terms(s.id) AS purchase_facts,
 (SELECT e.payload->'linePricing' FROM public.subscription_events e WHERE e.subscription_id=s.id
  AND e.event_type IN ('subscription.starter_graduated','subscription.customer_self_service.update_package_template',
   'subscription.customer_self_service.swap_base_line','subscription.customer_self_service.add_addon',
   'subscription.customer_self_service.remove_addon','subscription.customer_self_service.update_addon_quantity',
   'subscription.customer_self_service.update_plan_length','subscription.customer_self_service.update_base_mix',
   'subscription.customer_self_service.update_portion')
  ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) AS graduation_pricing,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('lineOrdinal',l.line_ordinal,'sku',l.sku,'quantity',l.quantity,
 'unitAmountMinor',l.unit_amount_minor) ORDER BY l.line_ordinal) FROM public.subscription_renewal_term_lines l
 WHERE l.subscription_id=s.id),'[]'::jsonb) AS lines
 FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
 LEFT JOIN public.subscription_method_states m ON m.subscription_id=s.id
 ${subscriptionCorrelationJoin}
 WHERE s.id=$1::uuid AND s.next_cycle_at=$2::timestamptz`;
export function subscriptionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("subscription_renewal_response_invalid");
  return value as Record<string, unknown>;
}
/** Native claim/prepare remain their original SQL transaction units. G23 is composed by the host. */
export function createPostgresRenewalStore(executor: SubscriptionQueryExecutor, codec: NativeRenewalCodec,
  withTransaction?: <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => Promise<T>): RenewalStorePort {
  async function header(input: RenewalSchedule, db = executor) {
    const result = await db.query(SNAPSHOT_SQL, [input.subscriptionId, input.scheduledAt]);
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
      const result = await executor.query(`SELECT due.*,to_char(due.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS scheduled_at,
        to_char(due.unattended_charge_authorized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS unattended_charge_authorized_at,${subscriptionCorrelationSql}
        FROM public.subscription_list_due_renewals($1::timestamptz,$2::integer) due
        JOIN public.subscriptions s ON s.id=due.subscription_id ${subscriptionCorrelationJoin}`, [asOf, limit]);
      return result.rows.map(row => codec.due(row));
    },
    async buildCycleSnapshots(input) {
      const stored = await executor.query(`SELECT cycle_snapshot FROM public.subscription_renewal_operations
        WHERE subscription_id=$1::uuid AND scheduled_at=$2::timestamptz`, [input.subscriptionId, input.scheduledAt]);
      if (stored.rows[0]) return codec.decode(subscriptionRecord(stored.rows[0].cycle_snapshot));
      const row = await header(input);
      // Imported terms may use an injected dialect without a purchase attachment.
      // The native purchase codec still validates its own required facts.
      if (row.purchase_facts == null || !nativeRetainedTerms(row)) return codec.freeze(row, input);
      if (!withTransaction) throw new Error("subscription_renewal_transaction_required");
      return withTransaction(async db => {
        await db.query("SELECT id FROM public.subscriptions WHERE id=$1::uuid FOR UPDATE", [input.subscriptionId]);
        const frozen = await db.query(`SELECT cycle_snapshot FROM public.subscription_renewal_operations
          WHERE subscription_id=$1::uuid AND scheduled_at=$2::timestamptz`, [input.subscriptionId, input.scheduledAt]);
        if (frozen.rows[0]) return codec.decode(subscriptionRecord(frozen.rows[0].cycle_snapshot));
        let current = await header(input, db);
        if (await graduateNativeRenewal(db, current)) current = await header(input, db);
        return codec.freeze(current, input);
      });
    },
    async readMandateEvidence(input) {
      const row = await header(input);
      return { authorized: row.health_state == null || row.health_state === "healthy", authorizationRef: String(row.authorization_ref),
        authorizedAt: String(row.unattended_charge_authorized_at) };
    },
    async admitDeliveryAlignment(input) {
      const row = await header(input);
      if (row.delivery_admission !== "allowed" && row.delivery_admission !== "blocked") throw new Error("subscription_renewal_delivery_admission_invalid");
      return row.delivery_admission === "allowed"
        ? { allowed: true, state: "static", reason: "allowed" }
        : { allowed: false, state: "static", reason: String(row.delivery_block_reason ?? "delivery_alignment_blocked"), deferred: false };
    },
    async claimDue(input) {
      if (withTransaction && codec.withDestination) return withTransaction(async db => {
        await db.query("SELECT id FROM public.subscriptions WHERE id=$1::uuid FOR UPDATE", [input.snapshot.subscriptionId]);
        const store = createPostgresRenewalStore(db, codec);
        const prior = await store.readRenewal(codec.identity(input.snapshot));
        if (prior) {
          const ref = prior.cycleSnapshot.orderSnapshot.shippingAddressRef;
          const snapshot = input.snapshot.orderSnapshot.shippingAddressRef == null && ref
            ? codec.withDestination!(input.snapshot, ref) : input.snapshot;
          return store.claimDue({ ...input, snapshot });
        }
        if (input.snapshot.frozenRevision === "native.purchase-renewal.v2") {
          let fresh = codec.freeze(await header(input.snapshot, db), input.snapshot);
          const destination = input.snapshot.orderSnapshot.shippingAddressRef;
          if (destination) fresh = codec.withDestination!(fresh, destination);
          if (codec.fingerprint(fresh) !== codec.fingerprint(input.snapshot)) throw new Error("subscription_renewal_snapshot_stale");
        }
        const document = subscriptionRecord((await db.query("SELECT public.commerce_read_destination('subscription',$1::uuid) AS destination", [input.snapshot.subscriptionId])).rows[0]?.destination);
        const snapshot = codec.withDestination!(input.snapshot, String(document.destinationId));
        return store.claimDue({ ...input, snapshot });
      });
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
