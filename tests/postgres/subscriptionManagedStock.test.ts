import { createPostgresStockWaitReads, stockWaitHealth } from "@openlup/platform/subscriptions";
import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readReviewedForwardRegistry, sqlSha256 } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";

// Working-tree behavioral proof, separate from the committed-byte CLI/catalog gates.
// Exact reviewed pins still bind every M10 unit; nothing assumes it is the last migration.
const probes = [
  ["20261024175000", "subscription_managed_atp_test.sql"],
  ["20261024180000", "subscription_stock_wait_test.sql"],
  ["20261024180000", "subscription_stock_wait_unpaid_discovery_test.sql"],
  ["20261024181000", "subscription_dunning_continuity_test.sql"],
  ["20261024182000", "subscription_list_due_for_winback_test.sql"],
  ["20261024185100", "stripe_refund_cumulative_snapshot_test.sql"],
  ["20261024185100", "order_refunded_outbox_event_test.sql"],
  ["20261024185100", "refunds_preserve_subscription_lifecycle_test.sql"],
  ["20261025090100", "subscription_dunning_duplicate_observation_test.sql"],
  ["20261024180000", "subscription_continuity_delivery_alignment_test.sql"],
  ["20261024184000", "subscription_cycle_reservation_preflight_test.sql"],
] as const;
let container: PostgresContainer | undefined;
let pool: Pool;
let db: PoolClient;

beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `m10-p5m-${process.pid}`, password: "synthetic-conformance" });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 2 });
  db = await pool.connect();
  await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
  for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
  }
  await db.query("SET ROLE postgres");
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  const names = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const [version] of probes) expect(names.some(name => name.startsWith(`${version}_`))).toBe(true);
  for (const name of names) {
    const bytes = readFileSync(`supabase/migrations/${name}`);
    const approval = registry.batchedForwards!.find(unit => unit.path === `supabase/migrations/${name}`);
    if (approval) {
      expect(sqlSha256(bytes)).toBe(approval.sha256);
      expect(bytes.equals(readFileSync(`scripts/fixtures/reviewed-m10/${approval.path}`))).toBe(true);
    }
    await db.query(bytes.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
  }
  await db.query("RESET ROLE; CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions");
  await db.query(`DO $$ DECLARE fn regprocedure; BEGIN
    FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
      JOIN pg_depend d ON d.objid=p.oid AND d.classid='pg_proc'::regclass
      JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgtap' AND d.deptype='e'
    LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC',fn); END LOOP;
  END $$; SET ROLE postgres; SET search_path=public,extensions`);
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

it.each(probes)("managed %s behavior: %s", async (_version, file) => {
  try {
    const result = await db.query(readFileSync(`supabase/tests/${file}`, "utf8"));
    const tap = tapLines(result);
    expect(tap.length, `${file}: no pgTAP assertions`).toBeGreaterThan(1);
    expect(tap.filter(line => /^not ok |^# (?:Looks like|Failed)/u.test(line)), tap.join("\n")).toEqual([]);
    const assertions = tap.filter(line => /^ok /u.test(line));
    expect(tap.some(line => line === `1..${assertions.length}`), tap.join("\n")).toBe(true);
    process.stdout.write(`${file}: ${assertions.length} pgTAP assertions PASS\n`);
  } finally {
    await db.query("ROLLBACK; RESET ROLE; SET ROLE postgres; SET search_path=public,extensions");
  }
}, 120_000);

function tapLines(result: QueryResult | QueryResult[]): string[] {
  const results = Array.isArray(result) ? result : [result];
  return results.flatMap(part => part.rows.flatMap(row => Object.values(row)))
    .filter((value): value is string => typeof value === "string" && /^(?:ok |not ok |1\.\.|#)/u.test(value));
}

it("excludes the occurrence routines from the installed managed catalogue and still settles a renewal", async () => {
  const signatures = [
    "public.subscriptions__allocate_renewal_occurrence(uuid,uuid,text,jsonb)",
    "public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid)",
    "public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid)",
    "public.subscriptions__create_renewal_v3_root(uuid,uuid,uuid,uuid,integer,text,text,text,integer)",
  ];
  expect((await db.query("SELECT signature,to_regprocedure(signature) AS installed FROM unnest($1::text[]) AS signature",
    [signatures])).rows).toEqual(signatures.map(signature => ({ signature, installed: null })));
  try {
    const tap = tapLines(await db.query(readFileSync("supabase/tests/subscription_late_payment_cycle_shift_test.sql", "utf8")));
    expect(tap.filter(line => /^(?:not ok |# (?:Looks like|Failed))/u.test(line)), tap.join("\n")).toEqual([]);
    const passed = tap.filter(line => /^ok /u.test(line));
    expect(tap).toContain(`1..${passed.length}`);
    expect(passed.some(line => line.includes("cycle_paid still reports the cycle scheduled date"))).toBe(true);
  } finally { await db.query("ROLLBACK; RESET ROLE; SET ROLE postgres; SET search_path=public,extensions"); }
}, 120_000);

it("exact-cover managed renewal witness rejects unconditional soft-demand subtraction", async () => {
  const signature = "public.inventory_available_to_promise(uuid,timestamptz,boolean)";
  const original = (await db.query<{ body: string }>("SELECT pg_get_functiondef($1::regprocedure) AS body", [signature])).rows[0].body;
  const exemption = "CASE WHEN p_for_subscription_renewal IS TRUE THEN 0 ELSE soft_demand END";
  expect(original.split(exemption)).toHaveLength(2);
  await db.query("BEGIN");
  try {
    await db.query(original.replace(exemption, "soft_demand"));
    // Run the very same positive allocator witness, with the transaction owned
    // here so both its fixture rows and the altered function roll back together.
    const probe = readFileSync("supabase/tests/subscription_managed_atp_test.sql", "utf8")
      .replace(/^BEGIN;$/mu, "").replace(/^ROLLBACK;$/mu, "");
    const tap = tapLines(await db.query(probe));
    const failure = tap.find(line => /^not ok /u.test(line)
      && line.includes("inside-horizon: exact-cover renewal reserves its full protected quantity"));
    expect(failure, tap.join("\n")).toBeDefined();
    expect(tap.join("\n")).toContain("23514: inventory_external_provider_insufficient_available_stock");
    process.stdout.write(`Renewal-exemption mutant rejected: ${failure}\n23514: inventory_external_provider_insufficient_available_stock\n`);
  } finally {
    await db.query("ROLLBACK; RESET ROLE; SET ROLE postgres; SET search_path=public,extensions");
  }
  expect((await db.query<{ body: string }>("SELECT pg_get_functiondef($1::regprocedure) AS body", [signature])).rows[0].body).toBe(original);
}, 120_000);

it("reads scoped managed stock waits and verifies canonical evidence and snapshots", async () => {
  const id = (suffix: number) => `cb100000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
  const [principal, client, subscription, other, otherSubscription, wait, otherWait, order, cycle, payment] =
    Array.from({ length: 10 }, (_, index) => id(index + 1));
  const now = "2026-08-01T10:00:00.000Z";
  const otherCycle = id(12), otherOrder = id(13), otherPayment = id(14);
  const deficit = { skuId: id(11), sku: "REFILL", productName: "Refill", sizeG: 100,
    requiredUnits: 2, reservedUnits: 0, availableUnits: 0, missingUnits: 2 };
  await db.query("RESET ROLE; BEGIN; SET LOCAL session_replication_role=replica");
  try {
    await db.query("INSERT INTO auth.users(id) VALUES ($1)", [principal]);
    await db.query(`INSERT INTO public.clients (id,email,auth_user_id) VALUES
      ($1,'one@example.invalid',$3),($2,'two@example.invalid',NULL)`, [client, other, principal]);
    await db.query(`INSERT INTO public.subscriptions (id,client_id,cadence_days,currency,next_cycle_at)
      VALUES ($1,$3,28,'XTS',$5),($2,$4,28,'XTS',$5)`, [subscription, otherSubscription, client, other, now]);
    await db.query(`INSERT INTO public.commerce_orders (id,client_id,subscription_id,subscription_cycle_id,status)
      VALUES ($1,$2,$3,$4,'pending_payment'),($5,$2,$3,NULL,'pending_payment')`,
    [order, client, subscription, cycle, otherOrder]);
    await db.query(`INSERT INTO public.subscription_cycles
      (id,subscription_id,scheduled_at,status,order_id,payment_id,cycle_number,engine_idempotency_key)
      VALUES ($1,$2,$3,'payment_pending',$4,$5,1,'stock-wait-read-test'),
        ($6,$2,$3::timestamptz+interval '28 days','payment_pending',NULL,$7,2,'stock-wait-read-next')`,
    [cycle, subscription, now, order, payment, otherCycle, otherPayment]);
    await db.query(`INSERT INTO public.commerce_payments (id,order_id,provider,amount_cents,currency)
      VALUES ($1,$2,'fixture',100,'XTS'),($3,$4,'fixture',100,'XTS')`, [payment, order, otherPayment, otherOrder]);
    await db.query(`INSERT INTO public.commerce_payment_intents
      (order_id,subscription_id,subscription_cycle_id,payment_id,target_kind,amount_cents,currency)
      VALUES ($1,$2,$3,$4,'subscription_cycle',100,'XTS')`, [order, subscription, cycle, payment]);
    await db.query(`INSERT INTO public.subscription_stock_wait_cases
      (id,client_id,subscription_id,scheduled_at,state,cycle_number,due_snapshot,template_snapshot,
        pricing_snapshot,order_snapshot,fingerprint,deficits,opened_at,last_checked_at,order_id,cycle_id)
      VALUES ($1,$3,$5,$7,'stock_secured',1,'{}','{}','{}','{}','fixture','[]',$7,$7,$8,$9),
        ($2,$4,$6,$7,'waiting',1,'{}','{}','{}','{}','fixture',$10,$7,$7,NULL,NULL)`,
    [wait, otherWait, client, other, subscription, otherSubscription, now, order, cycle, JSON.stringify([deficit, deficit])]);
    await db.query(`INSERT INTO public.communication_email_deliveries
      (purpose,template_slug,trigger_source,trigger_event,aggregate_type,aggregate_id,dedupe_key,status,updated_at,last_error_code)
      VALUES ('transactional','subscription-stock-wait-started','fixture','fixture','subscription_stock_wait',$1,'wait-latest','delivered',$3,NULL),
        ('transactional','subscription-stock-wait-started','fixture','fixture','subscription_stock_wait',$1,'wait-earlier','failed',
          $3::timestamptz-interval '1 min','connection_failed'),
        ('transactional','subscription-renewal-upcoming','fixture','fixture','subscription_stock_wait',$1,'unrelated','sent',$3,NULL),
        ('transactional','subscription-stock-wait-started','fixture','fixture','subscription_stock_wait',$2,'other-wait','sent',$3,NULL)`,
    [wait, otherWait, now]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK; SET ROLE postgres");
    throw error;
  }

  let snapshots = 0;
  const managedReads = (role: "postgres" | "service_role", afterOwnership?: () => Promise<void>) => createPostgresStockWaitReads({
    graph: "managed", authorizeOperator: async () => true, authorizeEvidence: async () => true,
    readOwnedAccount: async () => ({ principalId: principal, clientId: client, subscriptionIds: [subscription] }),
    async withReadSnapshot(work) {
      snapshots++;
      await db.query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL ROLE ${role}`);
      try {
        return await work({
          async query(sql, args) {
            const result = await db.query(sql, args);
            if (result.rows[0]?.allowed === true) await afterOwnership?.();
            return result;
          },
        });
      } finally { await db.query("ROLLBACK"); }
    },
  });
  const reads = managedReads("postgres");
  const customerReads = managedReads("service_role");
  const pending = await reads.listAdmin({ state: "all", page: 1, pageSize: 1 });
  expect(pending).toMatchObject({ totalCount: 2,
    productTotals: [{ sku: "REFILL", displayName: "Refill", missingUnits: 4, affectedCases: 1 }],
    cases: [{ id: wait, state: "stock_secured", orderId: order, cycleId: cycle, resumedAt: null,
      paymentStatus: "created", paymentEvidence: "recorded",
      notices: [
        { templateSlug: "subscription-stock-wait-started", status: "delivered", lastErrorCode: null },
        { templateSlug: "subscription-stock-wait-started", status: "failed", lastErrorCode: "connection_failed" },
      ] }],
  });
  expect(snapshots).toBe(1);
  expect(pending.cases[0]?.notices.map(notice => Date.parse(notice.updatedAt))).toEqual([Date.parse(now), Date.parse(now) - 60_000]);
  const owned = await customerReads.listCustomer();
  expect(owned.map(row => row.id)).toEqual([wait]);
  expect(owned[0]).not.toHaveProperty("paymentStatus");
  expect(await reads.listAdmin({ state: "all", page: 99, pageSize: 1 })).toMatchObject({
    totalCount: 2, productTotals: pending.productTotals, cases: [],
  });

  async function updateGraph(sql: string, values: unknown[]) {
    await db.query("BEGIN; SET LOCAL session_replication_role=replica");
    try { await db.query(sql, values); await db.query("COMMIT"); }
    catch (error) { await db.query("ROLLBACK"); throw error; }
  }
  await updateGraph(`WITH settled AS (UPDATE public.commerce_payment_intents SET status='succeeded' WHERE order_id=$1),
    paid AS (UPDATE public.commerce_orders SET status='paid' WHERE id=$1)
    UPDATE public.subscription_cycles SET status='paid' WHERE id=$2`, [order, cycle]);
  const paid = (await reads.listAdmin({ state: "all", page: 1, pageSize: 2 })).cases;
  expect(paid.map(row => [row.id, row.paymentStatus, row.paymentEvidence])).toEqual([
    [wait, "succeeded", "recorded"], [otherWait, "not_started", "not_applicable"],
  ]);
  await updateGraph("UPDATE public.commerce_payment_intents SET subscription_id=$2 WHERE order_id=$1", [order, otherSubscription]);
  expect((await reads.listAdmin({ state: "all", page: 1, pageSize: 1 })).cases[0]).toMatchObject({
    id: wait, orderId: order, paymentStatus: "not_started", paymentEvidence: "missing",
  });
  await updateGraph("UPDATE public.commerce_payment_intents SET subscription_id=$2 WHERE order_id=$1", [order, subscription]);
  for (const [label, sql, values, restored] of [
    ["bound cycle number differs from the case", "UPDATE public.subscription_cycles SET cycle_number=$2 WHERE id=$1",
      [cycle, 3], [cycle, 1]],
    ["order belongs to another cycle", "UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1",
      [order, otherCycle], [order, cycle]],
    ["cycle points back to another order", "UPDATE public.subscription_cycles SET order_id=$2 WHERE id=$1",
      [cycle, otherOrder], [cycle, order]],
    ["intent references another order's payment", "UPDATE public.commerce_payment_intents SET payment_id=$2 WHERE order_id=$1",
      [order, otherPayment], [order, payment]],
    ["cycle and intent share a payment belonging to another order", "UPDATE public.commerce_payments SET order_id=$2 WHERE id=$1",
      [payment, otherOrder], [payment, order]],
  ] as const) {
    await updateGraph(sql, [...values]);
    expect.soft((await reads.listAdmin({ state: "all", page: 1, pageSize: 1 })).cases[0], label).toMatchObject({
      id: wait, orderId: order, cycleId: cycle, cycleNumber: 1, paymentStatus: "not_started", paymentEvidence: "missing",
    });
    await updateGraph(sql, [...restored]);
  }

  await updateGraph("UPDATE public.subscription_stock_wait_cases SET state='waiting',deficits=$2 WHERE id=$1",
    [wait, JSON.stringify([deficit])]);
  const beforeDecoy = await customerReads.listCustomer();
  const observeAt = new Date(Date.parse(now) + 60_000);
  const health = stockWaitHealth(beforeDecoy, observeAt);
  expect(health).toMatchObject({ evidence: [{ healthy: true }], stalledCount: 0 });
  await db.query(`INSERT INTO public.communication_email_deliveries
    (purpose,template_slug,trigger_source,trigger_event,aggregate_type,aggregate_id,dedupe_key,status,updated_at)
    VALUES ('transactional','subscription-stock-wait-started','fixture','fixture','subscription',$1,'wrong-aggregate','failed',$2)`,
  [wait, observeAt]);
  const afterDecoy = await customerReads.listCustomer();
  expect.soft(afterDecoy[0]?.notices, "same-ID delivery from a different aggregate is excluded").toEqual(beforeDecoy[0]?.notices);
  expect.soft(stockWaitHealth(afterDecoy, observeAt), "other aggregate does not affect health").toEqual(health);

  let transferred = false;
  const concurrent = managedReads("service_role", async () => {
    await pool.query("UPDATE public.subscriptions SET client_id=$2 WHERE id=$1", [subscription, other]);
    transferred = true;
  });
  expect((await concurrent.listCustomer()).map(row => row.id), "managed read uses the ownership snapshot").toEqual([wait]);
  expect(transferred).toBe(true);
  await expect(customerReads.listCustomer()).rejects.toThrow("stock_wait_customer_forbidden");
  await db.query("SET ROLE postgres; SET search_path=public,extensions");
});
