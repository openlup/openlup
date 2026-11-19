import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { runManagedCompatPostgres } from "../../helpers/managedCompatPostgres.js";
import { closePostgres } from "../../helpers/postgresContainer.js";

const root = resolve(import.meta.dirname, "../../..");
const atp = "SELECT * FROM public.inventory_available_to_promise($1, $2, $3)";
const oms = `SELECT public.commerce_oms_admin_list_queue(
  $1, 25, $2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
  $3, NULL, 'created_desc', false
) AS queue`;
const reserve = `SELECT public.inventory_reserve_order(
  $1, $2, NULL, $3, $4, 1, $5, 'created', NULL, '{}', $6
) AS reservation`;

type Input = string | number | boolean | null;
type BenchScope = {
  rows: number;
  sku: string;
  provider: string;
  asOf: string;
  checkout_order: string;
  renewal_order: string;
  renewal_cycle: string;
  recently_paid: number;
  out_of_window_recently_paid: number;
};
type AtpOutput = {
  available_quantity: string;
  hard_hold_quantity: string;
  safety_quantity: string;
  soft_subscription_demand_quantity: string;
};
type QueueResult = {
  orderIds: string[];
  totalCount: number;
  summaryCounts: Record<string, number>;
  summaryTotals: { orderCount: number };
};
type Timing<T> = { value: T; milliseconds: number };
type Samples<T> = { value: T; medianMs: number; samplesMs: number[] };

function integerOption(value: string, min: number, max: number, option: string) {
  const n = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${option} must be an integer from ${min} through ${max}`);
  }
  return n;
}

async function installAndSeed(db: PoolClient, rows: number): Promise<BenchScope> {
  await db.query(readFileSync(join(root, "scripts/public-reference/subscription-prereqs.sql"), "utf8"));
  await db.query("SET ROLE postgres");
  const migrations = join(root, "supabase/migrations");
  for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrations, name), "utf8");
    await db.query(sql.replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
  }
  await db.query("SELECT set_config('openlup.bench_rows', $1, false)", [String(rows)]);
  const seeded = await db.query<BenchScope>(readFileSync(join(import.meta.dirname, "managedQueryData.sql"), "utf8"));
  const last: QueryResult<BenchScope> | undefined = Array.isArray(seeded) ? seeded.at(-1) : seeded;
  const scope = last?.rows[0];
  if (!scope) throw new Error("Managed benchmark fixture did not return its scope");
  return scope;
}

async function timed<T>(run: () => Promise<T>): Promise<Timing<T>> {
  const before = performance.now();
  const value = await run();
  return { value, milliseconds: performance.now() - before };
}

async function measure<T>(samples: number, run: () => Promise<T>): Promise<Samples<T>> {
  const value = await run();
  const milliseconds: number[] = [];
  for (let i = 0; i < samples; i++) milliseconds.push((await timed(run)).milliseconds);
  milliseconds.sort((a, b) => a - b);
  return { value, medianMs: milliseconds[Math.floor(milliseconds.length / 2)], samplesMs: milliseconds };
}

async function nestedPlan(db: PoolClient, text: string, values: Input[], marker: string) {
  const plans: unknown[] = [];
  let parseError: Error | undefined;
  const collect = ({ message }: { message?: string }) => {
    if (!message?.includes(marker)) return;
    const start = message.indexOf("\n");
    if (start === -1) return;
    try {
      plans.push(JSON.parse(message.slice(start + 1)));
    } catch (error) {
      parseError = new Error(`Invalid nested plan containing ${marker}`, { cause: error });
    }
  };
  db.on("notice", collect);
  try {
    await db.query("RESET ROLE; SET auto_explain.log_min_duration = '1ms'; SET ROLE service_role");
    await db.query(text, values);
    if (plans.length === 0) {
      await db.query("RESET ROLE; SET auto_explain.log_min_duration = '0ms'; SET ROLE service_role");
      await db.query(text, values);
    }
  } finally {
    db.off("notice", collect);
    await db.query("RESET ROLE; SET auto_explain.log_min_duration = '-1'; SET ROLE service_role");
  }
  if (parseError) throw parseError;
  if (plans.length !== 1) throw new Error(`Expected one nested plan containing ${marker}, received ${plans.length}`);
  return plans[0];
}

async function benchmarkReads(db: PoolClient, scope: BenchScope, samples: number) {
  await db.query(`
    RESET ROLE; LOAD 'auto_explain';
    SET auto_explain.log_nested_statements = on;
    SET auto_explain.log_analyze = on;
    SET auto_explain.log_buffers = on;
    SET auto_explain.log_timing = off;
    SET auto_explain.log_format = 'json';
    SET auto_explain.log_level = 'notice';
    SET client_min_messages = 'notice';
    SET ROLE service_role
  `);
  const asOf = new Date(scope.asOf).valueOf();
  const recent = new Date(asOf - 6 * 86_400_000).toISOString();
  const cases = [
    ["historyPage1", [1, null, null]],
    ["historyDeepPage", [Math.max(2, Math.floor(scope.rows * 0.8 / 25)), null, null]],
    ["recentPage1", [1, null, recent]],
    ["exactSearchHistory", [1, "BENCHMARK-ORDER-000001", null]],
    ["exactSearchRecent", [1, "BENCHMARK-ORDER-000001", recent]],
  ] as const;

  const available = async (renewal: boolean) => {
    const values = [scope.sku, scope.asOf, renewal];
    const result = await measure(samples, async () => (await db.query<AtpOutput>(atp, values)).rows[0]);
    return { ...result, plan: await nestedPlan(db, atp, values, "WITH components AS") };
  };
  const purchase = await available(false);
  const renewal = await available(true);
  assert.ok(BigInt(purchase.value.hard_hold_quantity) > 0n);
  assert.equal(BigInt(purchase.value.safety_quantity), 10n);
  assert.equal(
    BigInt(purchase.value.available_quantity) + BigInt(purchase.value.soft_subscription_demand_quantity),
    BigInt(renewal.value.available_quantity),
  );

  const history: Array<Samples<QueueResult> & { name: string; plan: unknown }> = [];
  for (const [name, values] of cases) {
    const args = [...values];
    const result = await measure(samples, async () => (await db.query<{ queue: QueueResult }>(oms, args)).rows[0].queue);
    history.push({ name, ...result, plan: await nestedPlan(db, oms, args, "WITH scoped_orders AS") });
  }
  assert.equal(history[0].value.totalCount, scope.rows + 2 - Math.floor((scope.rows + 2) / 10));
  assert.equal(history[0].value.totalCount, history[1].value.totalCount);
  assert.deepEqual(history[0].value.summaryCounts, history[1].value.summaryCounts);
  assert.deepEqual(history[0].value.summaryTotals, history[1].value.summaryTotals);
  assert.ok(history[2].value.totalCount < history[0].value.totalCount);
  assert.ok(scope.out_of_window_recently_paid > 0);
  assert.equal(history[2].value.summaryTotals.orderCount, scope.recently_paid);
  assert.equal(history[3].value.totalCount, 1);
  assert.deepEqual(history[3].value.orderIds, history[4].value.orderIds);
  return { atp: { purchase, renewal }, oms: history };
}

async function observeBlock(observer: PoolClient, waiterPid: number, holderPid: number) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const { rows } = await observer.query<{ blocked: boolean; wait_event: string | null }>(`
      SELECT $2 = ANY(pg_blocking_pids(pid)) AS blocked, wait_event
        FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
    `, [waiterPid, holderPid]);
    if (rows[0]?.blocked) return rows[0].wait_event;
    await delay(5);
  }
  throw new Error("The waiting allocator did not block on the holder transaction");
}

async function benchmarkContention(pool: Pool, observer: PoolClient, scope: BenchScope, renewal: boolean) {
  const holder = await pool.connect();
  try {
    const waiter = await pool.connect();
    let pending: Promise<Timing<string>> | undefined;
    let holding = false;
    try {
      await holder.query("BEGIN; SET LOCAL ROLE service_role");
      holding = true;
      const first = await holder.query<{ reservation: { status: string } }>(reserve,
        ["benchmark-holder", scope.checkout_order, null, scope.sku, "checkout_payment_window", scope.provider]);
      assert.equal(first.rows[0].reservation.status, "reserved");

      await waiter.query("BEGIN; SET LOCAL ROLE service_role; SET LOCAL lock_timeout = '15s'");
      const { rows: [{ pid: holderPid }] } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const { rows: [{ pid: waiterPid }] } = await waiter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const start = performance.now();
      pending = timed(async () => {
        const result = await waiter.query<{ reservation: { status: string } }>(reserve, [
          "benchmark-waiter", renewal ? scope.renewal_order : scope.checkout_order, renewal ? scope.renewal_cycle : null,
          scope.sku, renewal ? "subscription_retry_window" : "checkout_payment_window", scope.provider,
        ]);
        return result.rows[0].reservation.status;
      });
      // Observe an actual blocker before releasing the row. The timing includes
      // this harness's polling and rollback round trips, plus allocator work.
      void pending.catch(() => {});
      const waitEvent = await observeBlock(observer, waiterPid, holderPid);
      const observedAfterMs = performance.now() - start;
      await holder.query("ROLLBACK");
      holding = false;
      const measured = await pending;
      assert.equal(measured.value, "reserved");
      return { waitEvent, observedAfterMs, totalMs: measured.milliseconds };
    } finally {
      try {
        if (holding) await holder.query("ROLLBACK");
        await pending?.catch(() => {});
        await waiter.query("ROLLBACK");
      } finally {
        waiter.release();
      }
    }
  } finally {
    holder.release();
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    output: { type: "string" },
    rows: { type: "string", default: "10000" },
    samples: { type: "string", default: "5" },
  } });
  if (!values.output?.trim()) throw new Error("--output must name a new JSON report");
  const rows = integerOption(values.rows!, 100, 100_000, "rows");
  const samples = integerOption(values.samples!, 3, 25, "samples");
  const container = await runManagedCompatPostgres({ name: `managed-query-bench-${process.pid}`, password: "synthetic-benchmark" });
  const pool = new Pool({
    connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"),
    max: 3, connectionTimeoutMillis: 5_000, statement_timeout: 120_000, query_timeout: 125_000,
  });
  try {
    const db = await pool.connect();
    try {
      const scope = await installAndSeed(db, rows);
      const { rows: [postgres] } = await db.query(`SELECT version(), current_setting('jit') AS jit,
        current_setting('shared_buffers') AS shared_buffers, current_setting('work_mem') AS work_mem`);
      const { rows: [definitions] } = await db.query(`
        SELECT pg_get_functiondef('public.inventory_available_to_promise(uuid,timestamptz,boolean)'::regprocedure) AS atp,
               pg_get_functiondef('public.commerce_oms_admin_list_queue(integer,integer,text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,boolean)'::regprocedure) AS oms,
               pg_get_functiondef('public.inventory_reserve_order(text,uuid,uuid,uuid,uuid,integer,text,text,timestamptz,jsonb,text)'::regprocedure) AS allocator
      `);
      const functionHashes = Object.fromEntries(Object.entries(definitions).map(
        ([name, sql]) => [name, createHash("sha256").update(String(sql)).digest("hex")],
      ));
      const reads = await benchmarkReads(db, scope, samples);
      await db.query("RESET ROLE");
      const checkout = await benchmarkContention(pool, db, scope, false);
      const renewal = await benchmarkContention(pool, db, scope, true);
      const { rows: [{ remaining }] } = await db.query<{ remaining: number }>(`
        SELECT count(*)::integer AS remaining FROM public.inventory_reservations
        WHERE idempotency_key IN ('benchmark-holder', 'benchmark-waiter')
      `);
      assert.equal(remaining, 0);
      const report = JSON.stringify({
        rows, samples, localHost: { platform: process.platform, arch: process.arch, availableParallelism: availableParallelism() },
        postgres, functionHashes, asOf: scope.asOf, recentPaidFromOlderOrders: scope.out_of_window_recently_paid,
        ...reads, contention: { checkout, renewal },
      }, null, 2);
      writeFileSync(values.output, `${report}\n`, { flag: "wx" });
      console.log(`Managed query benchmark saved to ${values.output}`);
    } finally {
      db.release();
    }
  } finally {
    await closePostgres(container, pool);
  }
}

await main();
