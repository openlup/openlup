import type { StockWaitCase, StockWaitDeficit, StockWaitFrozenCase, StockWaitRecoveryBinding, StockWaitStorePort } from "./contracts/stockWait.js";
import type { RenewalSchedule } from "./contracts/renewal.js";
import { subscriptionRecord, type NativeRenewalCodec, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

export interface NativeStockWaitBinding {
  executor: SubscriptionQueryExecutor;
  withTransaction<T>(work: (executor: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  codec: NativeRenewalCodec;
  workerId: string;
}
export interface NativeStockWaitAdmission {
  waiting: boolean; caseId: string | null; response: Record<string, unknown>;
}
const nullable = (value: unknown): string | null => value == null ? null : String(value);
function binding(value: unknown): StockWaitRecoveryBinding {
  const r = subscriptionRecord(value);
  for (const key of ["caseId", "cycleId", "orderId", "paymentId", "engineIdempotencyKey"]) {
    if (r[key] !== null && typeof r[key] !== "string") throw new Error("stock_wait_binding_invalid");
  }
  return r as unknown as StockWaitRecoveryBinding;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("stock_wait_array_invalid");
  return value;
}
/** Each multi-statement mutation uses the host transaction. Payment execution is
 * deliberately outside this store. SQL owns stock locks and subtransactions. */
export function createPostgresStockWaitStore(options: NativeStockWaitBinding) {
  const { executor, codec } = options;
  async function invoke(db: SubscriptionQueryExecutor, name: string, values: unknown[]) {
    return (await db.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS response`, values)).rows[0]?.response;
  }
  async function deficits(db: SubscriptionQueryExecutor, value: unknown): Promise<StockWaitDeficit[]> {
    const rows = array(value).map(subscriptionRecord);
    if (rows.length === 0) return [];
    const catalog = (await db.query("SELECT id,sku,title FROM public.catalog_skus WHERE sku=ANY($1::text[])", [rows.map(r => String(r.sku))])).rows;
    return rows.map(value => {
      const r = subscriptionRecord(value);
      // Catalogue labels enrich the projection; quantities still come only from N3.
      const item = catalog.find(item => item.sku === r.sku);
      if (!item) throw new Error("stock_wait_catalog_sku_missing");
      return { skuId: String(item.id), sku: String(r.sku), displayName: String(item.title), size: null,
        required: Number(r.requiredUnits), reserved: Number(r.reservedUnits),
        available: Number(r.availableUnits), missing: Number(r.missingUnits) };
    });
  }
  async function readCase(db: SubscriptionQueryExecutor, caseId: string): Promise<StockWaitCase | null> {
    const rows = (await db.query(`SELECT public.subscription_stock_wait_read(c.id) AS projection,
      c.cycle_snapshot,op.identity_key,cycle.id AS bound_cycle_id,ord.id AS bound_order_id,intent.id AS payment_id
      FROM public.subscription_stock_wait_cases c JOIN public.subscription_renewal_operations op ON op.id=c.renewal_operation_id
      LEFT JOIN public.subscription_cycles cycle ON cycle.renewal_operation_id=op.id
      LEFT JOIN public.commerce_orders ord ON ord.renewal_operation_id=op.id
      LEFT JOIN public.commerce_settlement_intents intent ON intent.renewal_operation_id=op.id WHERE c.id=$1::uuid`, [caseId])).rows;
    if (!rows[0]) return null;
    const r = subscriptionRecord(rows[0].projection), snapshot = codec.decode(subscriptionRecord(rows[0].cycle_snapshot));
    if (!["waiting", "stock_secured", "resumed", "closed"].includes(String(r.state))) throw new Error("stock_wait_state_invalid");
    return { subscriptionId: String(r.subscription_id), scheduledAt: snapshot.scheduledAt, scheduledInstant: snapshot.scheduledInstant,
      caseId: String(r.id), clientId: String(r.client_id), state: r.state as StockWaitCase["state"],
      frozenSnapshot: snapshot, frozenFingerprint: String(r.fingerprint),
      binding: { caseId, cycleId: nullable(rows[0].bound_cycle_id), orderId: nullable(rows[0].bound_order_id),
        paymentId: nullable(rows[0].payment_id), engineIdempotencyKey: String(rows[0].identity_key) },
      deficits: await deficits(db, r.deficits), fulfillmentRef: nullable(r.fulfillment_id), blockReason: nullable(r.block_reason),
      openedAt: String(r.opened_at), checkedAt: nullable(r.last_checked_at), selectedAt: nullable(r.last_selected_at),
      securedAt: nullable(r.stock_secured_at), resumedAt: nullable(r.resumed_at), closedAt: nullable(r.closed_at),
      startedNoticeKey: `subscription_stock_wait:${caseId}:started`, resumedNoticeKey: `subscription_stock_wait:${caseId}:resumed`,
      noticeEligible: r.waitingNoticeRelevant === true };
  }
  async function frozen(db: SubscriptionQueryExecutor, value: unknown): Promise<StockWaitFrozenCase> {
    const r = subscriptionRecord(value), b = binding(r.binding), snapshot = codec.decode(subscriptionRecord(r.snapshot));
    return { subscriptionId: snapshot.subscriptionId, scheduledAt: snapshot.scheduledAt, scheduledInstant: snapshot.scheduledInstant, operationId: String(r.operationId),
      case: b.caseId === null ? null : await readCase(db, b.caseId), frozenSnapshot: snapshot,
      frozenFingerprint: String(r.operationFingerprint), binding: b };
  }
  async function recover(db: SubscriptionQueryExecutor, input: Parameters<StockWaitStorePort["recoverRefusedSchedule"]>[0]) {
    // Match the SQL lock order, then fence the schedule and generation not present
    // in N3's SQL signature. No provider-owned refusal is converted to a wait.
    await db.query(`SELECT id FROM public.subscriptions WHERE id=(SELECT subscription_id
      FROM public.subscription_renewal_operations WHERE id=$1::uuid) FOR UPDATE`, [input.operationId]);
    const row = (await db.query(`SELECT op.*,op.scheduled_at=$3::timestamptz AS schedule_matches,c.id AS case_id,c.state AS case_state,
      EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations r WHERE r.renewal_operation_id=op.id
        AND r.status='held' AND r.expires_at>$4::timestamptz) AS live_hold,
      EXISTS(SELECT 1 FROM public.subscription_cycles WHERE renewal_operation_id=op.id) OR
      EXISTS(SELECT 1 FROM public.commerce_orders WHERE renewal_operation_id=op.id) OR
      EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE renewal_operation_id=op.id) OR
      EXISTS(SELECT 1 FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=op.id AND
        (outcome<>'refused' OR reason IS NULL OR reason NOT IN ('inventory_unavailable','reservation_expired') OR external_ref IS NOT NULL)) AS has_artifacts
      FROM public.subscription_renewal_operations op LEFT JOIN public.subscription_stock_wait_cases c ON c.renewal_operation_id=op.id
      WHERE op.id=$1::uuid AND c.id=$2::uuid FOR UPDATE OF op`, [input.operationId, input.caseId, input.scheduledAt, input.now])).rows[0];
    if (!row || !row.schedule_matches || row.operation_fingerprint !== input.frozenFingerprint) {
      return { outcome: "refused", reason: "stale_snapshot" } as const;
    }
    if (row.has_artifacts || row.attempt_prepared_at != null || row.external_attempt_ref != null || row.external_attempt_acknowledged_at != null) {
      return { outcome: "refused", reason: "external_ownership" } as const;
    }
    if (!(row.state === "refused" && ["inventory_unavailable", "reservation_expired"].includes(String(row.terminal_reason)))
      && !(row.state === "reserved" && row.case_state === "stock_secured")) return { outcome: "refused", reason: "not_stock_only" } as const;
    const securedReplay = row.case_state === "stock_secured" && row.state === "reserved" && row.live_hold === true
      && new Date(String(row.lease_expires_at)).getTime() > Date.parse(input.now)
      && [input.claimGeneration, input.claimGeneration + 1].includes(Number(row.claim_generation));
    if (!securedReplay && Number(row.claim_generation) !== input.claimGeneration) return { outcome: "refused", reason: "stale_snapshot" } as const;
    if (!securedReplay && new Date(String(row.lease_expires_at)).getTime() > Date.parse(input.now)) return { outcome: "refused", reason: "lease_active" } as const;
    const result = subscriptionRecord(await invoke(db, "subscription_stock_wait_recover_refusal", [input.operationId, input.frozenFingerprint, options.workerId, input.now]));
    if (result.waiting === true) return { outcome: "refused", reason: "inventory_unavailable" } as const;
    return { outcome: "recovered", operation: codec.readback(result), replayed: result.replayed === true } as const;
  }
  const port: StockWaitStorePort = {
    async listCandidates(input) {
      return options.withTransaction(async db => {
        const values = array(await invoke(db, "subscription_stock_wait_candidates", [input.limit, input.asOf]));
        const result: StockWaitFrozenCase[] = [];
        for (const value of values) result.push(await frozen(db, value));
        return result;
      });
    },
    async readFrozenCase(input) {
      if (input.caseId === null) return null;
      const result = await readCase(executor, input.caseId);
      if (result && Object.keys(input).some(key => input[key as keyof StockWaitRecoveryBinding] !== result.binding[key as keyof StockWaitRecoveryBinding])) {
        throw new Error("stock_wait_frozen_binding_changed");
      }
      return result;
    },
    async reserveAndTransition(input) {
      return options.withTransaction(async db => {
        const row = (await db.query(`SELECT op.id,op.claim_generation,op.scheduled_at::text FROM public.subscription_stock_wait_cases c
          JOIN public.subscription_renewal_operations op ON op.id=c.renewal_operation_id WHERE c.id=$1::uuid`, [input.caseId])).rows[0];
        if (!row) throw new Error("stock_wait_case_missing");
        const result = await recover(db, { ...input, operationId: String(row.id), claimGeneration: Number(row.claim_generation), scheduledAt: String(row.scheduled_at) });
        if (result.outcome === "refused" && result.reason !== "inventory_unavailable") throw new Error(`stock_wait_${result.reason}`);
        const current = await readCase(db, input.caseId);
        if (!current) throw new Error("stock_wait_case_missing");
        return current;
      });
    },
    recoverRefusedSchedule(input) { return options.withTransaction(db => recover(db, input)); },
  };
  return {
    ...port,
    async readFrozen(input: RenewalSchedule) {
      return options.withTransaction(async db => {
        const value = await invoke(db, "subscription_stock_wait_frozen", [input.subscriptionId, input.scheduledAt]);
        return value == null ? null : frozen(db, value);
      });
    },
    async listNormalDue(input: { limit: number; asOf: string }) {
      return array(await invoke(executor, "subscription_stock_wait_normal_due", [input.limit, input.asOf])).map(value => codec.due(subscriptionRecord(value)));
    },
    async deficits(input: { snapshot: import("./contracts/renewal.js").RenewalFrozenSnapshot; operationId: string; now: string }) {
      return options.withTransaction(async db => deficits(db, await invoke(db, "subscription_stock_wait_deficits", [codec.encode(input.snapshot), input.operationId, input.now])));
    },
    async admit(input: { operationId: string; claimToken: string; snapshot: import("./contracts/renewal.js").RenewalFrozenSnapshot; recovery?: StockWaitRecoveryBinding; now: string }): Promise<NativeStockWaitAdmission> {
      const request = { operationId: input.operationId, claimToken: input.claimToken, snapshot: codec.encode(input.snapshot),
        operationFingerprint: codec.fingerprint(input.snapshot), identityKey: codec.identity(input.snapshot), worker: options.workerId };
      const due = input.recovery ? { stockWaitRecovery: input.recovery } : {};
      const response = subscriptionRecord(await invoke(executor, "subscription_stock_wait_admit", [request, due, input.now]));
      if (response.waiting === true && typeof response.caseId !== "string") throw new Error("stock_wait_case_identity_missing");
      return { waiting: response.waiting === true, caseId: nullable(response.caseId), response };
    },
    async enqueue(caseId: string, kind: "started" | "resumed") {
      await executor.query(`SELECT public.subscription_stock_wait_enqueue(c,$2::text)
        FROM public.subscription_stock_wait_cases c WHERE c.id=$1::uuid`, [caseId, kind]);
    },
    markResumed(orderId: string) {
      return options.withTransaction(async db => {
        const value = await invoke(db, "subscription_stock_wait_mark_resumed", [orderId]);
        return value == null ? null : readCase(db, String(subscriptionRecord(value).id));
      });
    },
  };
}
