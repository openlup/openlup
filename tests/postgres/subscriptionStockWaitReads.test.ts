import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresStockWaitReads, stockWaitHealth, type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import type { StockWaitReadProjection } from "@openlup/platform/subscriptions/contracts";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const client = uuid(1), other = uuid(2), principal = uuid(3);
const subscription = uuid(11), otherSubscription = uuid(12), omittedSubscription = uuid(13), securedSubscription = uuid(14);
const caseA = uuid(21), caseB = uuid(22), caseC = uuid(23), caseD = uuid(24);
const operationB = uuid(32), orderB = uuid(51), cycleB = uuid(54), intentB = uuid(55);
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
    readOwnedAccount: async () => ({ principalId: principal, clientId: client, subscriptionIds: [subscription, securedSubscription] }),
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
      if (sql.includes("commerce_settlement_intents")) lookedUp.push(...result.rows.map(row => row.id));
      return result;
    }));
    const result = await port.listAdmin(page("all", 1, 3));
    expect(lookedUp).toEqual([caseB]);
    expect(result.cases.map(({ paymentStatus, paymentEvidence }) => [paymentStatus, paymentEvidence]))
      .toEqual([["not_started", "not_applicable"], ["succeeded", "recorded"], ["not_started", "missing"]]);
  }],
  ...(["payment_pending", "paid"] as const).map(phase => [`LC10-D-292 projects a ${phase} native operation before resumption`, async () => {
    await seed({}, phase);
    const port = readers();
    const links = { id: caseB, caseKind: "legacy", orderId: orderB, cycleId: cycleB,
      state: "stock_secured", resumedAt: null, fulfillmentId: null };
    const result = await port.listAdmin(page("all", 2, 1));
    expect(result).toMatchObject({ totalCount: 4, productTotals: total(8, 3), cases: [{
      ...links, paymentStatus: phase === "paid" ? "succeeded" : "created", paymentEvidence: "recorded",
    }] });
    for (const list of [await port.listEvidence(), await port.listCustomer()]) {
      const secured = list.find(row => row.id === caseB);
      expect(secured).toMatchObject(links);
      expect(secured).not.toHaveProperty("paymentStatus");
    }
  }] as const),
  ["LC10-D-292 an intent outside the renewal operation is missing evidence", async () => {
    await seed({}, "unbound_intent");
    const result = await readers().listAdmin(page("all", 2, 1));
    expect(result.cases[0]).toMatchObject({
      id: caseB, orderId: orderB, paymentStatus: "not_started", paymentEvidence: "missing",
    });
  }],
  ["LC10-D-295 a missing renewal operation fails the projection visibly", async () => {
    await seed();
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [operationB]);
    await db.query("SET LOCAL session_replication_role = origin");
    const port = readers();
    await expect(port.listAdmin(page())).rejects.toThrow("carrierAvailable");
    await expect(port.listEvidence()).rejects.toThrow("carrierAvailable");
    await expect(port.listCustomer()).rejects.toThrow("carrierAvailable");
  }],
  ["LC10-D-295 a renewal operation with the wrong cycle coordinates is refused", async () => {
    await seed();
    await db.query("UPDATE public.subscription_renewal_operations SET cycle_number=3 WHERE id=$1", [operationB]);
    await expect(readers().listAdmin(page())).rejects.toThrow("carrierAvailable");
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
      ? { rows: [{ id: caseB, kind: "legacy", status: "unrecognized" }] } : db.query(sql, args)));
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
    ["managed", "42P01", 'relation "archive.subscription_stock_wait_cases" does not exist'],
    ["managed", "08006", "connection unavailable"],
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
    ["cancelled", "next_cycle_at", "cancelled"],
    ["active", "next_cycle_at + interval '1 hour'", "schedule_changed"],
    ["active", "NULL", "schedule_changed"],
  ] as const).map(([status, anchor, reason]) => [`LC10-D-295 ${status} ${anchor} blocker`, async () => {
    await seed();
    await db.query(`UPDATE public.subscriptions SET status=$2,next_cycle_at=${anchor} WHERE id=ANY($1::uuid[])`, [[subscription, securedSubscription], status]);
    const rows = (await readers().listAdmin(page())).cases;
    expect(rows[0]).toMatchObject({ id: caseA, automaticRecoveryEligible: false, independentBlock: reason });
    expect(rows[1]).toMatchObject({ id: caseB, automaticRecoveryEligible: false, independentBlock: null });
    expect(ids(await readers().listCustomer())).toEqual([["legacy", caseB]]);
  }] as const),
  ["LC10-D-295 superseded case remains in operator view when its anchor matches again", async () => {
    await seed();
    await db.query("UPDATE public.subscription_stock_wait_cases SET state='closed',block_reason='schedule_superseded' WHERE id=$1", [caseA]);
    expect((await readers().listAdmin(page())).cases[0]).toMatchObject({
      id: caseA, automaticRecoveryEligible: false, independentBlock: "schedule_superseded",
    });
    expect(ids(await readers().listCustomer())).toEqual([["legacy", caseB]]);
    expect(ids(await readers().listEvidence())).toEqual([["legacy", caseC], ["legacy", caseB]]);
  }],
  ["LC10-D-296 evidence open only, stale wait excluded, secured retained", async () => {
    await seed();
    await db.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 hour' WHERE id=$1", [subscription]);
    expect(ids(await readers().listEvidence())).toEqual([["legacy", caseC], ["legacy", caseB]]);
  }],
  ["LC10-D-296 2000 oldest checks before eligibility", async () => {
    await seedMany(2001);
    await db.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 hour' WHERE id=$1", [uuid(10001)]);
    const result = await readers().listEvidence();
    expect(result.map(row => row.id)).toEqual(Array.from({ length: 1999 }, (_, i) => uuid(30002 + i)));
  }],
  ["LC10-D-297 opened time and ID ties", async () => {
    await seed();
    const result = await readers().listAdmin(page("all", 2, 1));
    expect(ids(result.cases)).toEqual([["legacy", caseB]]);
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
  ["LC10-D-298 reject malformed summary even outside the page", async () => {
    await seed({ [caseA]: { deficits: [{ ...line(2), missingUnits: "2" }] } });
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
    const cases = await readers().listCustomer();
    expect(ids(cases)).toEqual([["legacy", caseA], ["legacy", caseB]]);
    for (const row of cases) expect(row).not.toHaveProperty("paymentStatus");
  }],
  ["LC10-D-299 explicit subscription list excludes other open cases on the same account", async () => {
    await seed({ [caseD]: { state: "stock_secured" } });
    expect(ids(await readers().listCustomer())).toEqual([["legacy", caseA], ["legacy", caseB]]);
  }],
  ["LC10-D-299 only open even when the closed subscription is in scope", async () => {
    await seed();
    const port = readers({ readOwnedAccount: async () => ({
      principalId: principal, clientId: client, subscriptionIds: [subscription, securedSubscription, omittedSubscription],
    }) });
    expect(ids(await port.listCustomer())).toEqual([["legacy", caseA], ["legacy", caseB]]);
  }],
  ["LC10-D-299 an empty owned set checks the client and returns no cases", async () => {
    await seed();
    const port = readers({ readOwnedAccount: async () => ({ principalId: principal, clientId: client, subscriptionIds: [] }) });
    expect(await port.listCustomer()).toEqual([]);
  }],
  ["LC10-D-299 rejects a mixed owned and foreign subscription set", async () => {
    await seed();
    const port = readers({ readOwnedAccount: async () => ({
      principalId: principal, clientId: client, subscriptionIds: [subscription, securedSubscription, otherSubscription],
    }) });
    await expect(port.listCustomer()).rejects.toThrow("stock_wait_customer_forbidden");
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
    const port = readers({ readOwnedAccount: async () => ({ principalId: uuid(4), clientId: client, subscriptionIds: [subscription, securedSubscription] }) });
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
    ["future sent notice", () => projection({ notices: [{ ...projection().notices[0]!, updatedAt: new Date(now.getTime() + 1).toISOString() }] }), false, 1],
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
  return readers({ graph, ...instrument(async sql => {
    if (!sql.includes("public.subscription_stock_wait_cases")) return { rows: [{ allowed: true }] };
    throw Object.assign(new Error(message), { code });
  }) });
}

// Seed persisted read facts directly. Producer behavior is covered by the stock-wait
// and renewal command suites. Restore trigger execution before invoking any reader.
async function seed(overrides: Record<string, {
  state?: StockWaitReadProjection["state"];
  openedMinutes?: number;
  deficits?: Record<string, unknown>[];
}> = {}, paymentPhase: "payment_pending" | "paid" | "unbound_intent" = "paid") {
  await db.query("SET LOCAL session_replication_role = replica");
  await db.query(`INSERT INTO public.clients (id,email,principal_id) VALUES
    ($1,'one@example.invalid',$3),($2,'two@example.invalid',NULL)`, [client, other, principal]);
  await db.query(`INSERT INTO public.subscriptions (id, client_id, cadence_days, next_cycle_at) VALUES
    ($1,$4,28,$6),($2,$5,28,$6),($3,$4,28,$6),($7,$4,28,$6)`, [subscription, otherSubscription, omittedSubscription, client, other, now, securedSubscription]);
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES ($1,'test-item','Item')", [uuid(90)]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES ($1,$1,'ITEM','Item')", [uuid(90)]);

  const data = [
    [caseC, otherSubscription, other, "waiting", 2, 15, orderB, uuid(33)],
    [caseA, subscription, client, "waiting", 1, 10, null, uuid(31)],
    [caseD, omittedSubscription, client, "closed", 3, 20, uuid(53), uuid(34)],
    [caseB, securedSubscription, client, "stock_secured", 1, 5, null, operationB],
  ] as const;
  for (const [id, sub, owner, state, openedMinutes, checkedMinutes, orderId, operation] of data) {
    const override = overrides[id];
    const deficits = JSON.stringify(override?.deficits ?? (id === caseC
      ? [line(1), line(1)] : [line(id === caseB ? 0 : id === caseD ? 4 : 2)]));
    const coordinates = [id, sub, owner, override?.state ?? state, now, deficits, override?.openedMinutes ?? openedMinutes,
      checkedMinutes, orderId, operation];
    await db.query(`INSERT INTO public.subscription_renewal_operations
      (id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,
        claim_token,claimed_by,claimed_at,lease_expires_at)
      VALUES($1,$2,$3,2,repeat('a',48)||$1::uuid::text,repeat('a',64),'{}',gen_random_uuid(),'fixture',
        $3::timestamptz,$3::timestamptz+interval '5 min')`, [operation, sub, now]);
    await db.query(`INSERT INTO public.subscription_stock_wait_cases
      (id,subscription_id,client_id,state,scheduled_at,deficits,opened_at,last_checked_at,order_id,cycle_number,
        fingerprint,identity_key,due_snapshot,cycle_snapshot,renewal_operation_id)
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$5::timestamptz + $7 * interval '1 min',
        $5::timestamptz - $8 * interval '1 min',$9,2,repeat('a',64),repeat('a',48)||$10::uuid::text,'{}','{}',$10)`, coordinates);
  }
  const paid = paymentPhase !== "payment_pending";
  await db.query(`INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint)
    VALUES ($1,$2,$3,$4,$5,repeat('a',64)),($6,$7,$3,'payment_pending',$8,repeat('a',64))`,
  [cycleB, securedSubscription, now, paid ? "paid" : "payment_pending", operationB, uuid(57), otherSubscription, uuid(33)]);
  await db.query(`INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor,
    renewal_operation_id,renewal_operation_fingerprint)
    VALUES ($1,$2,$3,$4,'XXX',100,$5,repeat('a',64)),($6,$7,$8,'pending_payment','XXX',100,$9,repeat('a',64))`,
  [orderB, client, cycleB, paid ? "paid" : "pending_payment", operationB, uuid(52), other, uuid(57), uuid(33)]);
  await db.query(`INSERT INTO public.commerce_settlement_intents
    (id,order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at,renewal_operation_id,renewal_operation_fingerprint)
    VALUES ($1,$2,'test',$3,100,'XXX','test-a',$4,$5,CASE WHEN $5::uuid IS NOT NULL THEN repeat('a',64) END)`,
  [intentB, orderB, paid ? "settled" : "created", paid ? now : null, paymentPhase === "unbound_intent" ? uuid(34) : operationB]);

  // Other event kinds, aggregates and wait-open bookkeeping must stay out.
  const events = [
    [caseA, "started", "", now],
    [caseA, "resumed", "", new Date(now.getTime() - 60_000)],
    [caseA, "resumed", ":v2", now],
    [caseB, "opened", "", now],
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
  await db.query(`INSERT INTO public.subscription_renewal_operations
    (id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,
      claim_token,claimed_by,claimed_at,lease_expires_at)
    SELECT gen_random_uuid(),id,$2,2,repeat('a',48)||id::text,repeat('a',64),'{}',gen_random_uuid(),'fixture',
      $2::timestamptz,$2::timestamptz+interval '5 min'
    FROM public.subscriptions WHERE client_id=$1`, [client, now]);
  await db.query(`INSERT INTO public.subscription_stock_wait_cases
    (id,subscription_id,client_id,state,scheduled_at,deficits,opened_at,last_checked_at,
     renewal_operation_id,cycle_number,fingerprint,identity_key,due_snapshot,cycle_snapshot)
    SELECT ('00000000-0000-4000-8000-' || lpad((30000+n)::text,12,'0'))::uuid,
     ('00000000-0000-4000-8000-' || lpad((10000+n)::text,12,'0'))::uuid,$1,'waiting',$2::timestamptz,'[]',
     $2::timestamptz + n * interval '1 ms',$2::timestamptz + n * interval '1 ms',
     op.id,2,repeat('a',64),op.identity_key,'{}','{}' FROM generate_series(1,$3::integer) n
    JOIN public.subscription_renewal_operations op
      ON op.subscription_id=('00000000-0000-4000-8000-' || lpad((10000+n)::text,12,'0'))::uuid`, [client, now, count]);
  await db.query("SET LOCAL session_replication_role = origin");
}
