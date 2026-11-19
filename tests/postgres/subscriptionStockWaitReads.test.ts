import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresStockWaitReads, stockWaitHealth, type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import type { StockWaitReadProjection } from "@openlup/platform/subscriptions/contracts";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const client = uuid(1), other = uuid(2), principal = uuid(3);
const subscription = uuid(11), otherSubscription = uuid(12), omittedSubscription = uuid(13);
const caseA = uuid(21), caseB = uuid(22), caseC = uuid(23), caseD = uuid(24);
const successorOperation = uuid(32), successorOrder = uuid(51), successorCycle = uuid(54), successorIntent = uuid(55);
const total = (missing: number, cases: number) => [{ sku: "ITEM", displayName: "Item", missingUnits: missing, affectedCases: cases }];
let container: PostgresContainer | undefined, pool: Pool, db: PoolClient, now: Date;

beforeAll(async () => {
  container = await runPostgresContainer({ name: `stock-wait-reads-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Stock wait reads require PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool }).apply();
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);
beforeEach(async () => {
  db = await pool.connect();
  await db.query("BEGIN");
  now = (await db.query("SELECT date_trunc('milliseconds', transaction_timestamp()) AS now")).rows[0].now;
});
afterEach(async () => { try { await db.query("ROLLBACK"); } finally { db.release(); } });

function readers(options: Partial<Parameters<typeof createPostgresStockWaitReads>[0]> = {}) {
  return createPostgresStockWaitReads({
    graph: "native", withReadSnapshot: work => work(db),
    authorizeOperator: async () => true, authorizeEvidence: async () => true,
    readOwnedAccount: async () => ({ principalId: principal, clientId: client, subscriptionIds: [subscription] }),
    ...options,
  });
}
function instrument(query: SubscriptionQueryExecutor["query"]) {
  return { withReadSnapshot: <T>(work: (executor: SubscriptionQueryExecutor) => Promise<T>) => work({ query }) };
}
const page = (state: "all" | "waiting" | "closed" = "all", number = 1, pageSize = 2) => ({ state, page: number, pageSize });
const ids = (rows: StockWaitReadProjection[]) => rows.map(row => [row.caseKind, row.id]);
const projection = (overrides: Partial<StockWaitReadProjection> = {}): StockWaitReadProjection => ({
  schemaVersion: 2, caseKind: "legacy", id: caseA, subscriptionId: subscription, clientId: client,
  state: "waiting", scheduledAt: now.toISOString(), openedAt: now.toISOString(), lastCheckedAt: now.toISOString(),
  cycleNumber: 2, orderId: null, cycleId: null, fulfillmentId: null, stockSecuredAt: null, resumedAt: null, closedAt: null,
  deficits: [{ sku: "ITEM", displayName: "Item", skuId: uuid(90), size: null, required: 2, reserved: 0, available: 0, missing: 2 }],
  automaticRecoveryEligible: true, independentBlock: null, blockReason: null,
  notices: [{ templateSlug: "subscription-stock-wait-started", status: "sent", updatedAt: now.toISOString(), lastErrorCode: null }],
  ...overrides,
});

// Each case isolates a filter, refusal or clock edge. The installed reader also
// checks the complete totals outside a page.
const cases = [
  ["LC10-D-292 known-order-only and mapped status", async () => {
    await seed();
    const lookedUp: unknown[] = [];
    const port = readers(instrument(async (sql, args) => {
      const result = await db.query(sql, args);
      if (sql.includes("commerce_settlement_intents")) lookedUp.push(...result.rows.map(row => row.order_id));
      return result;
    }));
    const result = await port.listAdmin(page("all", 1, 3));
    expect(lookedUp).toEqual([uuid(51)]);
    expect(result.cases.map(({ paymentStatus, paymentEvidence }) => [paymentStatus, paymentEvidence]))
      .toEqual([["not_started", "not_applicable"], ["succeeded", "recorded"], ["not_started", "missing"]]);
  }],
  ...(["payment_pending", "paid"] as const).map(phase => [`LC10-D-292 projects a ${phase} successor before resumption`, async () => {
    await seed({}, phase);
    const port = readers();
    const links = { id: caseB, caseKind: "successor", orderId: successorOrder, cycleId: successorCycle,
      state: "stock_secured", resumedAt: null, fulfillmentId: null };
    const result = await port.listAdmin(page("all", 2, 1));
    expect(result).toMatchObject({ totalCount: 4, productTotals: total(8, 3), cases: [{
      ...links, paymentStatus: phase === "paid" ? "succeeded" : "created", paymentEvidence: "recorded",
    }] });
    for (const list of [await port.listEvidence(), await port.listCustomer()]) {
      const successor = list.find(row => row.id === caseB);
      expect(successor).toMatchObject(links);
      expect(successor).not.toHaveProperty("paymentStatus");
    }
  }] as const),
  ["LC10-D-292 an intent outside the successor generation is missing evidence", async () => {
    await seed({}, "unbound_intent");
    const result = await readers().listAdmin(page("all", 2, 1));
    expect(result.cases[0]).toMatchObject({
      id: caseB, orderId: successorOrder, paymentStatus: "not_started", paymentEvidence: "missing",
    });
  }],
  ["LC10-D-295 a missing successor carrier fails the projection visibly", async () => {
    await seed();
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query("DELETE FROM public.subscription_successor_operations_v2 WHERE id=$1", [successorOperation]);
    await db.query("SET LOCAL session_replication_role = origin");
    const port = readers();
    await expect(port.listAdmin(page())).rejects.toThrow("carrierAvailable");
    await expect(port.listEvidence()).rejects.toThrow("carrierAvailable");
    await expect(port.listCustomer()).rejects.toThrow("carrierAvailable");
  }],
  ["LC10-D-292 no order lookup with no IDs", async () => {
    await seed();
    const port = readers(instrument((sql, args) => {
      if (sql.includes("commerce_settlement_intents")) throw new Error("payment lookup should be skipped");
      return db.query(sql, args);
    }));
    expect((await port.listAdmin(page("all", 1, 1))).cases[0]?.paymentStatus).toBe("not_started");
  }],
  ["LC10-D-292 invalid status refused", async () => {
    await seed();
    const port = readers(instrument(async (sql, args) => sql.includes("commerce_settlement_intents")
      ? { rows: [{ order_id: uuid(51), status: "unrecognized" }] } : db.query(sql, args)));
    await expect(port.listAdmin(page())).rejects.toThrow("stock_wait_admin_payment_status_invalid");
  }],
  ["LC10-D-292 payment failure propagates", async () => {
    await seed();
    const port = readers(instrument(async (sql, args) => {
      if (sql.includes("commerce_settlement_intents")) throw new Error("payment unavailable");
      return db.query(sql, args);
    }));
    await expect(port.listAdmin(page())).rejects.toThrow("payment unavailable");
  }],
  ["LC10-D-293 scoped notices, latest first, nullable error and milestone fields", async () => {
    await seed();
    const { cases: rows } = await readers().listAdmin(page());
    expect(rows[0]).toMatchObject({ orderId: null, cycleId: null, fulfillmentId: null, resumedAt: null,
      stockSecuredAt: null, closedAt: null, notices: [
        { templateSlug: "subscription-stock-wait-started", status: "sent", lastErrorCode: null },
        { templateSlug: "subscription-stock-wait-resumed", status: "failed", lastErrorCode: "connection_failed" },
      ] });
    expect(rows[1]?.notices).toEqual([]);
  }],
  ["LC10-D-293 managed delivery template and case filters use persisted delivery evidence", async () => {
    const deficits = [{ ...line(2), skuId: uuid(90), productName: "Item", sizeG: null }];
    await seed({ [caseA]: { deficits }, [caseC]: { deficits }, [caseD]: { deficits } });
    await db.query(`CREATE TABLE public.communication_email_deliveries(
      id uuid, aggregate_id text, template_slug text, status text, last_error_code text, updated_at timestamptz
    );
    CREATE TABLE public.commerce_payment_intents(order_id uuid, status text)`);
    await db.query(`INSERT INTO public.communication_email_deliveries VALUES
      ($4,$1,'subscription-stock-wait-started','delivered',NULL,$3),
      ($5,$1,'subscription-stock-wait-started','failed','connection_failed',$3::timestamptz - interval '1 min'),
      ($6,$1,'subscription-renewal-upcoming','sent',NULL,$3::timestamptz + interval '1 min'),
      ($7,$2,'subscription-stock-wait-started','sent',NULL,$3)`, [caseA, caseC, now, uuid(71), uuid(72), uuid(73), uuid(74)]);
    const result = await readers({ graph: "managed" }).listAdmin(page("waiting", 1, 1));
    expect(ids(result.cases)).toEqual([["legacy", caseA]]);
    expect(result.cases[0]?.notices.map(row => ({ ...row, updatedAt: Date.parse(row.updatedAt) }))).toEqual([
      { templateSlug: "subscription-stock-wait-started", status: "delivered", lastErrorCode: null, updatedAt: now.getTime() },
      { templateSlug: "subscription-stock-wait-started", status: "failed", lastErrorCode: "connection_failed", updatedAt: now.getTime() - 60_000 },
    ]);
    expect(result).toMatchObject({ totalCount: 2, productTotals: total(4, 2) });
  }],
  ...["42P01", "PGRST205"].map(code => [`LC10-D-294 ${code} named managed relation is compatible empty`, async () => {
    const port = failedCases("managed", code, 'relation "public.subscription_stock_wait_cases" does not exist');
    expect(await port.listEvidence()).toEqual([]);
    expect(await port.listCustomer()).toEqual([]);
    expect(await port.listAdmin(page())).toEqual({ cases: [], page: 1, pageSize: 2, totalCount: 0, productTotals: [] });
    expect(await port.readOperatorSummary("all")).toEqual({ totalCount: 0, productTotals: [] });
  }] as const),
  ...([
    ["managed", "42P01", 'relation "public.subscriptions" does not exist'],
    ["managed", "42P01", 'relation "public.subscription_stock_wait_cases_archive" does not exist'],
    ["managed", "42501", 'permission denied for relation "public.subscription_stock_wait_cases"'],
    ["native", "42P01", 'relation "public.subscription_stock_wait_cases" does not exist'],
  ] as const).map(([graph, code, message]) => [`LC10-D-294 ${graph} ${code} ${message} propagates`, async () => {
    await expect(failedCases(graph, code, message).listEvidence()).rejects.toMatchObject({ code, message });
  }] as const),
  ["LC10-D-295 equal instants with different offsets", async () => {
    await seed();
    await db.query("SET LOCAL TIME ZONE 'America/New_York'");
    const row = (await readers().listCustomer())[0];
    expect(row).toMatchObject({ id: caseA, automaticRecoveryEligible: true, independentBlock: null });
  }],
  ...([
    ["paused", "next_cycle_at", "paused"],
    ["active", "next_cycle_at + interval '1 hour'", "schedule_changed"],
    ["active", "NULL", "schedule_changed"],
  ] as const).map(([status, anchor, reason]) => [`LC10-D-295 ${status} ${anchor} blocker`, async () => {
    await seed();
    await db.query(`UPDATE public.subscriptions SET status=$2,next_cycle_at=${anchor} WHERE id=$1`, [subscription, status]);
    const rows = (await readers().listAdmin(page())).cases;
    expect(rows[0]).toMatchObject({ id: caseA, automaticRecoveryEligible: false, independentBlock: reason });
    expect(rows[1]).toMatchObject({ id: caseB, automaticRecoveryEligible: false, independentBlock: null });
    expect(ids(await readers().listCustomer())).toEqual([["successor", caseB]]);
  }] as const),
  ["LC10-D-295 superseded generation is ineligible but remains in the operator view", async () => {
    await seed();
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query("UPDATE public.subscription_successor_wait_cases_v2 SET superseded_by_proposal_id=$1 WHERE id=$2", [uuid(61), caseB]);
    await db.query("SET LOCAL session_replication_role = origin");
    expect((await readers().listAdmin(page())).cases[1]).toMatchObject({ id: caseB, automaticRecoveryEligible: false });
    expect(ids(await readers().listCustomer())).toEqual([["legacy", caseA]]);
    expect(ids(await readers().listEvidence())).toEqual([["legacy", caseC], ["legacy", caseA]]);
  }],
  ["LC10-D-296 evidence open only, stale wait excluded, secured retained", async () => {
    await seed();
    await db.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 hour' WHERE id=$1", [subscription]);
    expect(ids(await readers().listEvidence())).toEqual([["legacy", caseC], ["successor", caseB]]);
  }],
  ["LC10-D-296 2000 oldest checks before eligibility", async () => {
    await seedMany(2001);
    await db.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 hour' WHERE id=$1", [uuid(10001)]);
    const result = await readers().listEvidence();
    expect(result.map(row => row.id)).toEqual(Array.from({ length: 1999 }, (_, i) => uuid(30002 + i)));
  }],
  ["LC10-D-297 opened time and ID ties across generations", async () => {
    await seed();
    const result = await readers().listAdmin(page("all", 2, 1));
    expect(ids(result.cases)).toEqual([["successor", caseB]]);
    expect(result).toMatchObject({ page: 2, pageSize: 1, totalCount: 4, productTotals: total(8, 3) });
  }],
  ["LC10-D-297 opened time sorts before ID", async () => {
    await seed({ [caseC]: { openedMinutes: -8 } });
    expect(ids((await readers().listAdmin(page())).cases)).toEqual([["legacy", caseC], ["legacy", caseA]]);
  }],
  ["LC10-D-297 exact state filter applies to the page and complete totals", async () => {
    await seed();
    const result = await readers().listAdmin(page("waiting", 2, 1));
    expect(ids(result.cases)).toEqual([["legacy", caseC]]);
    expect(result).toMatchObject({ totalCount: 2, productTotals: total(4, 2) });
  }],
  ["LC10-D-298 empty page retains global totals and independent summary", async () => {
    await seed();
    const port = readers();
    expect(await port.listAdmin(page("waiting", 99, 1))).toEqual({ cases: [], page: 99, pageSize: 1, totalCount: 2, productTotals: total(4, 2) });
    expect(await port.readOperatorSummary("closed")).toEqual({ totalCount: 1, productTotals: total(4, 1) });
  }],
  ["LC10-D-298 a zero count skips summary and side reads", async () => {
    const calls: string[] = [];
    const port = readers(instrument((sql, args) => { calls.push(sql); return db.query(sql, args); }));
    expect(await port.listAdmin(page())).toEqual({ cases: [], page: 1, pageSize: 2, totalCount: 0, productTotals: [] });
    expect(calls).toHaveLength(1);
  }],
  ["LC10-D-298 summary failure is visible", async () => {
    await seed();
    const port = readers(instrument((sql, args) => {
      if (sql.includes("affectedCases")) throw new Error("summary unavailable");
      return db.query(sql, args);
    }));
    await expect(port.listAdmin(page())).rejects.toThrow("summary unavailable");
  }],
  ["LC10-D-298 contradictory exact count is visible", async () => {
    await seed();
    const port = readers(instrument((sql, args) => {
      if (sql.includes("affectedCases")) return Promise.resolve({ rows: [{ totalCount: 0, productTotals: [], incomplete: false }] });
      return db.query(sql, args);
    }));
    await expect(port.listAdmin(page())).rejects.toThrow("stock_wait_summary_count_mismatch");
  }],
  ["LC10-D-298 missing summary facts are visible even beyond the last page", async () => {
    await seed({ [caseA]: { deficits: [{ sku: "UNRESOLVED", missingUnits: 2 }] } });
    await expect(readers().listAdmin(page("waiting", 99, 1))).rejects.toThrow("stock_wait_summary_evidence_invalid");
  }],
  ["LC10-D-298 notice failure is visible to each listing", async () => {
    await seed();
    const port = readers(instrument(async (sql, args) => {
      if (sql.includes("transactional_delivery_receipts")) throw new Error("notices unavailable");
      return db.query(sql, args);
    }));
    await expect(port.listAdmin(page())).rejects.toThrow("notices unavailable");
    await expect(port.listEvidence()).rejects.toThrow("notices unavailable");
    await expect(port.listCustomer()).rejects.toThrow("notices unavailable");
  }],
  ["LC10-D-299 binds client and exact subscription IDs, and returns open rows only", async () => {
    await seed();
    const port = readers({ readOwnedAccount: async () => ({ principalId: principal, clientId: client, subscriptionIds: [subscription, otherSubscription] }) });
    const cases = await port.listCustomer();
    expect(ids(cases)).toEqual([["legacy", caseA], ["successor", caseB]]);
    for (const row of cases) expect(row).not.toHaveProperty("paymentStatus");
  }],
  ["LC10-D-299 explicit subscription list excludes other open cases on the same account", async () => {
    await seed({ [caseD]: { state: "stock_secured" } });
    expect(ids(await readers().listCustomer())).toEqual([["legacy", caseA], ["successor", caseB]]);
  }],
  ["LC10-D-299 only open even when the closed subscription is in scope", async () => {
    await seed();
    const port = readers({ readOwnedAccount: async () => ({
      principalId: principal, clientId: client, subscriptionIds: [subscription, omittedSubscription],
    }) });
    expect(ids(await port.listCustomer())).toEqual([["legacy", caseA], ["successor", caseB]]);
  }],
  ["LC10-D-299 empty owned set makes no query", async () => {
    const port = readers({
      ...instrument(async () => { throw new Error("unexpected query"); }),
      readOwnedAccount: async () => ({ principalId: principal, clientId: client, subscriptionIds: [] }),
    });
    expect(await port.listCustomer()).toEqual([]);
  }],
  ["LC10-D-299 customer cap before eligibility", async () => {
    await seedMany(101);
    await db.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 hour' WHERE id=$1", [uuid(10001)]);
    const port = readers({ readOwnedAccount: async () => ({
      principalId: principal, clientId: client, subscriptionIds: Array.from({ length: 101 }, (_, index) => uuid(10001 + index)),
    }) });
    expect((await port.listCustomer()).map(row => row.id)).toEqual(Array.from({ length: 99 }, (_, index) => uuid(30002 + index)));
  }],
  ["LC10-D-299 operator, evidence worker and customer authority refuse independently", async () => {
    const noReads = instrument(async () => { throw new Error("unexpected query"); });
    const port = readers({ ...noReads, authorizeOperator: async () => false, authorizeEvidence: async () => false, readOwnedAccount: async () => null });
    await expect(port.listAdmin(page())).rejects.toThrow("stock_wait_operator_forbidden");
    await expect(port.readOperatorSummary("all")).rejects.toThrow("stock_wait_operator_forbidden");
    await expect(port.listEvidence()).rejects.toThrow("stock_wait_evidence_forbidden");
    await expect(port.listCustomer()).rejects.toThrow("stock_wait_customer_forbidden");
  }],
  ["LC10-D-299 authenticated principal must own the named account", async () => {
    await seed();
    const port = readers({ readOwnedAccount: async () => ({ principalId: uuid(4), clientId: client, subscriptionIds: [subscription] }) });
    await expect(port.listCustomer()).rejects.toThrow("stock_wait_customer_forbidden");
  }],
  ...([-1, 0, 1_800_000, 1_800_001] as const).flatMap(age => ["case", "notice"].map(kind =>
    [`LC10-D-300 ${kind} age ${age}ms`, async () => {
      const checked = new Date(now.getTime() - age).toISOString();
      const row = kind === "case" ? projection({ lastCheckedAt: checked }) : projection({
        notices: [{ ...projection().notices[0]!, status: "processing", updatedAt: checked }],
      });
      const healthy = age >= 0 && age <= 1_800_000;
      expect(stockWaitHealth([row], now)).toEqual({
        evidence: [{ subscriptionId: subscription, scheduledAt: row.scheduledAt, healthy }], stalledCount: healthy ? 0 : 1,
      });
    }] as const)),
  ...([
    ["no shortage", () => projection({ deficits: [{ ...projection().deficits[0]!, missing: 0 }] }), false, 1],
    ["invalid case time", () => projection({ lastCheckedAt: "unavailable" }), false, 1],
    ["fresh planned notice", () => projection({ notices: [{ ...projection().notices[0]!, status: "planned" }] }), true, 0],
    ["fresh queued notice", () => projection({ notices: [{ ...projection().notices[0]!, status: "queued" }] }), true, 0],
    ["independent blocker", () => projection({ independentBlock: "paused" }), false, 1],
    ["durable blocker", () => projection({ blockReason: "unknown_inventory" }), false, 1],
    ["secured with blocker", () => projection({ state: "stock_secured", blockReason: "unknown_inventory" }), false, 1],
    ["secured without blocker", () => projection({ state: "stock_secured" }), false, 0],
    ["no started notice", () => projection({ notices: [{ ...projection().notices[0]!, templateSlug: "subscription-stock-wait-resumed" }] }), false, 1],
    ["failed latest notice", () => projection({ notices: [{ ...projection().notices[0]!, status: "failed" }, ...projection().notices] }), false, 1],
    ["delivered old notice", () => projection({ notices: [{ ...projection().notices[0]!, status: "delivered", updatedAt: new Date(now.getTime() - 3_600_000).toISOString() }] }), true, 0],
  ] as const).map(([name, row, healthy, stalledCount]) =>
    [`LC10-D-300 ${name}`, async () => {
      expect(stockWaitHealth([row()], now)).toMatchObject({ evidence: [{ healthy }], stalledCount });
    }] as const),
] as const;

it.each(cases)("%s", async (_name, check) => check());

function failedCases(graph: "native" | "managed", code: string, message: string) {
  return readers({ graph, ...instrument(async () => { throw Object.assign(new Error(message), { code }); }) });
}

// Seed persisted read facts directly. Producer behavior is covered by the stock-wait
// and successor command suites. Restore trigger execution before invoking any reader.
async function seed(overrides: Record<string, {
  state?: StockWaitReadProjection["state"];
  openedMinutes?: number;
  deficits?: Record<string, unknown>[];
}> = {}, successorPhase: "payment_pending" | "paid" | "unbound_intent" = "paid") {
  await db.query("SET LOCAL session_replication_role = replica");
  await db.query(`INSERT INTO public.clients (id,email,principal_id) VALUES
    ($1,'one@example.invalid',$3),($2,'two@example.invalid',NULL)`, [client, other, principal]);
  await db.query(`INSERT INTO public.subscriptions (id, client_id, cadence_days, next_cycle_at) VALUES
    ($1,$4,28,$6),($2,$5,28,$6),($3,$4,28,$6)`, [subscription, otherSubscription, omittedSubscription, client, other, now]);
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES ($1,'test-item','Item')", [uuid(90)]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES ($1,$1,'ITEM','Item')", [uuid(90)]);

  const data = [
    [caseC, otherSubscription, other, "waiting", 2, 15, uuid(52), uuid(33)],
    [caseA, subscription, client, "waiting", 1, 10, null, uuid(31)],
    [caseD, omittedSubscription, client, "closed", 3, 20, uuid(53), uuid(34)],
    [caseB, subscription, client, "stock_secured", 1, 5, null, successorOperation],
  ] as const;
  for (const [id, sub, owner, state, openedMinutes, checkedMinutes, orderId, operation] of data) {
    const override = overrides[id];
    const deficits = JSON.stringify(override?.deficits ?? (id === caseC
      ? [line(1), line(1)] : [line(id === caseB ? 0 : id === caseD ? 4 : 2)]));
    const coordinates = [id, sub, owner, override?.state ?? state, now, deficits, override?.openedMinutes ?? openedMinutes,
      checkedMinutes, orderId, operation];
    const table = id === caseB ? "subscription_successor_wait_cases_v2" : "subscription_stock_wait_cases";
    const lineage = id === caseB ? "operation_id, root_case_id" : "renewal_operation_id";
    const links = id === caseB ? "$10,$11" : "$10";
    await db.query(`INSERT INTO public.${table} (id,subscription_id,client_id,state,scheduled_at,deficits,
      opened_at,last_checked_at,order_id,cycle_number,fingerprint,identity_key,due_snapshot,cycle_snapshot,${lineage})
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$5::timestamptz + $7 * interval '1 min',
      $5::timestamptz - $8 * interval '1 min',$9,2,repeat('a',64),$10::uuid::text,'{}','{}',${links})`,
    id === caseB ? [...coordinates, caseA] : coordinates);
  }
  const paid = successorPhase !== "payment_pending";
  await db.query(`INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status)
    VALUES ($1,$2,$3,$4)`, [successorCycle, subscription, now, paid ? "paid" : "payment_pending"]);
  await db.query(`INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor)
    VALUES ($1,$2,$3,$4,'XXX',100)`, [successorOrder, client, successorCycle, paid ? "paid" : "pending_payment"]);
  await db.query(`INSERT INTO public.commerce_settlement_intents
    (id,order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at)
    VALUES ($1,$2,'test',$3,100,'XXX','test-a',$4),(gen_random_uuid(),$5,'test','failed',100,'XXX','test-b',NULL)`,
  [successorIntent, successorOrder, paid ? "settled" : "created", paid ? now : null, uuid(53)]);
  await db.query(`INSERT INTO public.subscription_successor_operations_v2
    (id,root_operation_id,proposal_id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,
     due_snapshot,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,
     attempt_prepared_at,terminal_outcome,terminal_at,cycle_id,order_id,settlement_intent_id)
    VALUES ($1,$2,$3,$4,$5::timestamptz,2,'fixture:successor-operation-generation:bound-identity',repeat('a',64),
     '{}','{}',$6,gen_random_uuid(),'fixture',$5,$5::timestamptz+interval '5 min',$5,$7,$8,$9,$10,$11)`,
  [successorOperation, uuid(31), uuid(81), subscription, now, paid ? "succeeded" : "attempt_prepared",
    paid ? "succeeded" : null, paid ? now : null, successorCycle, successorOrder,
    successorPhase === "unbound_intent" ? uuid(56) : successorIntent]);

  // One generation's events cannot attach to the other. A bookkeeping event
  // for a case and a delivery event for another case must both stay out.
  const events = [
    [caseA, "started", "", now],
    [caseA, "resumed", "", new Date(now.getTime() - 60_000)],
    [caseA, "resumed", ":v2", now],
    [caseB, "started", "", now],
    [caseA, "opened", ":v1", now],
    [caseC, "resumed", "", now],
  ] as const;
  for (const [id, event, version, updated] of events) {
    const key = `subscription_stock_wait:${id}:${event}${version}`;
    const type = `subscription_stock_wait.${event}${version.replace(":", ".")}`;
    await db.query(`INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, payload, status, created_at)
      VALUES ('subscription_stock_wait',$1,$2,$3,'{}','pending',$4)`, [id, type, key, updated]);
    if (id === caseA && version === "") {
      const accepted = event === "started";
      await db.query(`INSERT INTO public.transactional_delivery_receipts
        (idempotency_key,command_fingerprint,state,delivery_reference,error_code,attempt_count,created_at,updated_at,accepted_at,failed_at)
        VALUES ($1,repeat('a',64),$2,$3,$4,1,$5,$5,$6,$7)`,
      [key, accepted ? "accepted" : "failed", accepted ? "fixture" : null, accepted ? null : "connection_failed",
        updated, accepted ? updated : null, accepted ? null : updated]);
    }
  }
  await db.query("SET LOCAL session_replication_role = origin");
}
function line(missingUnits: number) {
  return { sku: "ITEM", requiredUnits: 4, reservedUnits: 0, availableUnits: 4 - missingUnits, missingUnits };
}
async function seedMany(count: number) {
  await db.query("SET LOCAL session_replication_role = replica");
  await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES ($1,'one@example.invalid',$2)", [client, principal]);
  await db.query(`INSERT INTO public.subscriptions (id,client_id,cadence_days,next_cycle_at)
    SELECT ('00000000-0000-4000-8000-' || lpad((10000+n)::text,12,'0'))::uuid,$1,28,$2
    FROM generate_series(1,$3::integer) n`, [client, now, count]);
  await db.query(`INSERT INTO public.subscription_stock_wait_cases
    (id,subscription_id,client_id,state,scheduled_at,deficits,opened_at,last_checked_at,
     renewal_operation_id,cycle_number,fingerprint,identity_key,due_snapshot,cycle_snapshot)
    SELECT ('00000000-0000-4000-8000-' || lpad((30000+n)::text,12,'0'))::uuid,
     ('00000000-0000-4000-8000-' || lpad((10000+n)::text,12,'0'))::uuid,$1,'waiting',$2::timestamptz,'[]',
     $2::timestamptz + n * interval '1 ms',$2::timestamptz + n * interval '1 ms',
     gen_random_uuid(),2,repeat('a',64),'fixture','{}','{}' FROM generate_series(1,$3::integer) n`, [client, now, count]);
  await db.query("SET LOCAL session_replication_role = origin");
}

it.each(['summary', 'evidence', 'admin', 'owned', 'foreign', 'non-operator', 'machine'] as const)(
  'G1-D5 starter stock-wait route %s', async view => {
    const { bindStarterCatalogue } = await import('../../examples/neutral-store/host/catalogue-binding.ts');
    const { starterCatalogue } = await import('../../examples/neutral-store/host/catalogue-selection.ts');
    const { dispatchAction, pendingBindings } = await import('../../examples/neutral-store/host/bindings.ts');
    const { canonicalCatalogDraftJson } = await import('@openlup/platform/catalog');
    await seed({ [caseB]: { state: 'waiting', deficits: [line(3)] } }, 'payment_pending');
    const registration = starterCatalogue.select(), bindings = pendingBindings();
    const customer = view === 'owned' || view === 'foreign';
    const actor = customer ? { principalRef: principal, customerRef: client, operatorRef: null }
      : { principalRef: principal, customerRef: null, operatorRef: view === 'non-operator' ? null : principal };
    const isolated: string[] = [];
    bindStarterCatalogue({ db, actions: bindings.actions, authorizeHuman: async () => ({ ok: true,
      role: 'admin', userId: principal, isMachineActor: view === 'machine' }),
    options: { registration, readEnabled: () => true, writerEnabled: () => false, publication: {
      transactions: { run: work => work({ async query(sql, args) {
        // The fixture is intentionally uncommitted. Record the host's isolation request on this same connection.
        if (sql.startsWith('SET TRANSACTION')) { isolated.push(sql); return { rows: [] }; }
        return db.query(sql, args);
      } }) },
      rules: { canonicalizeDocument: canonicalCatalogDraftJson, classifySkuChange: () => 'inconclusive',
        deriveSkuFacts: () => ({}), validateProduct: () => [] },
      readiness: async () => ({ ready: false, reasons: [] }), verifyMedia: async () => false,
    } } });
    const result = await dispatchAction(bindings, customer ? 'subscription.stockWait' : 'operator.stockWait',
      customer ? { subscriptionRef: view === 'foreign' ? otherSubscription : subscription }
        : { view: view === 'non-operator' ? 'summary' : view === 'machine' ? 'evidence' : view },
      { actor, config: registration.configuration, commandKey: 'starter-stock-wait-witness' });
    if (view === 'foreign' || view === 'non-operator' || view === 'machine') {
      expect(result).toMatchObject({ ok: false, code: view === 'foreign' ? 'stock_wait_customer_forbidden'
        : view === 'machine' ? 'stock_wait_evidence_forbidden' : 'operator_required' });
      expect(isolated).toEqual([]);
      return;
    }
    const wait = { id: caseB, caseKind: 'successor', subscriptionId: subscription, state: 'waiting',
      automaticRecoveryEligible: true };
    if (view === 'summary') expect(result).toMatchObject({ ok: true, value: { totalCount: 3, productTotals: total(7, 3) } });
    else if (view === 'admin') expect(result).toMatchObject({ ok: true, value: { cases: expect.arrayContaining([expect.objectContaining({
      ...wait, paymentStatus: 'created',
    })]) } });
    else expect(result).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining(wait)]) });
    expect(isolated).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY']);
  });
