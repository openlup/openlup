import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import {
  createNativeRenewalCodec,
  createNativeSubscriptionBinding,
  createPostgresRenewalSettlementPort,
  createSandboxRenewalPolicy,
} from "@openlup/platform/subscriptions";
import type { RenewalPaymentRail } from "@openlup/platform/subscriptions/contracts";
import { createPostgresMigrationRunner } from "../../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../../server/adapters/postgres/qualifiedInstall.js";
import {
  closePostgres,
  runPostgresContainer,
  waitForPostgresTcpReady,
  type PostgresContainer,
} from "../../helpers/postgresContainer.js";

const installation = {
  generation: "qualified-v2",
  roleMode: "installer-managed",
  migrationLogin: "postgres",
  bootstrapLogin: "postgres",
  runtimeLogin: "starter_runtime",
  restoreLogin: "starter_restore",
} as const;

const AT = "2030-09-01T12:00:00.000Z";
const AS_OF = "2030-09-01T13:00:00.000Z";
const NORMAL_DUE_SIGNATURE = "public.subscription_stock_wait_normal_due(integer,timestamptz)";

function integerOption(value: string, min: number, max: number, option: string): number {
  const n = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${option} must be an integer from ${min} through ${max}`);
  }
  return n;
}

function rttListOption(value: string): number[] {
  const items = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (items.length === 0) throw new Error("--rtt-ms must contain at least one integer");
  return items.map((part) => integerOption(part, 0, 5_000, "rtt-ms"));
}

function round(ms: number): number {
  return Number(ms.toFixed(2));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function runtimeConnectionString(adminUrl: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = installation.runtimeLogin;
  url.password = password;
  return url.toString();
}

async function seedDataset(admin: Pool, cycles: number): Promise<void> {
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  await admin.query("UPDATE public.subscriptions SET status = 'paused' WHERE status = 'active'");

  const productId = "00000000-0000-4000-8000-000000000001";
  const sku = "BENCH-SKU-01";
  const sourceKey = "bench-source";

  await admin.query(
    "INSERT INTO public.catalog_products(id, slug, name) VALUES($1, $2, 'Benchmark Product') ON CONFLICT (id) DO NOTHING",
    [productId, "bench-product-01"],
  );
  await admin.query(
    "INSERT INTO public.catalog_skus(id, product_id, sku, title) VALUES($1, $1, $2, 'Benchmark SKU') ON CONFLICT (id) DO NOTHING",
    [productId, sku],
  );
  await admin.query(
    `INSERT INTO public.fulfillment_stock_current(
       source_key, sku, total_quantity, for_sale_quantity, reserved_unavailable_quantity,
       inventory_class, last_synced_at, stale_after, sync_run_id, idempotency_key, operation_fingerprint
     ) VALUES($1, $2, $3, $3, 0, 'sellable', $4::timestamptz, $4::timestamptz + interval '1 year', 'bench', 'bench-stock-01', $5)
     ON CONFLICT (source_key, sku) DO UPDATE SET total_quantity = EXCLUDED.total_quantity, for_sale_quantity = EXCLUDED.for_sale_quantity`,
    [sourceKey, sku, cycles * 10, AT, "a".repeat(64)],
  );

  // Seed N due subscriptions with next_cycle_at distributed over the 24h preceding AT
  // so backlog age is measurable and deterministic across runs.
  await admin.query(
    `WITH seed AS (
       SELECT
         n,
         ('00000000-0000-4000-8000-' || lpad(to_hex(n + 100), 12, '0'))::uuid AS id,
         $2::timestamptz - make_interval(secs => ((($1::bigint - n)::double precision / GREATEST($1::bigint, 1)) * 86400.0)) AS due_at
       FROM generate_series(1, $1::integer) AS n
     ),
     ins_clients AS (
       INSERT INTO public.clients(id, email)
       SELECT id, id::text || '@example.invalid' FROM seed
     ),
     ins_subs AS (
       INSERT INTO public.subscriptions(id, client_id, cadence_days, next_cycle_at)
       SELECT id, id, 28, due_at FROM seed
     ),
     ins_cycles AS (
       INSERT INTO public.subscription_cycles(id, subscription_id, scheduled_at, status)
       SELECT id, id, due_at - interval '28 days', 'paid' FROM seed
     ),
     ins_orders AS (
       INSERT INTO public.commerce_orders(id, client_id, subscription_cycle_id, status)
       SELECT id, id, id, 'paid' FROM seed
     ),
     ins_destinations AS (
       INSERT INTO public.commerce_destinations(id, client_id, purchase_order_id, address, registration_key, registration_fingerprint)
       SELECT id, id, id, '{"recipientName":"Bench","line1":"1 Main St","city":"Fixture City","postalCode":"00-001","country":"ZZ"}'::jsonb, 'bench-dest:' || id::text, repeat('c', 64)
       FROM seed
     ),
     ins_activations AS (
       INSERT INTO public.subscription_activations(
         order_id, client_id, subscription_id, cadence_days, state,
         payment_fingerprint, declare_idempotency_key, activation_idempotency_key, activated_at
       )
       SELECT id, id, id, 28, 'active', repeat('b', 64), 'bench-declare:' || id::text, 'bench-activate:' || id::text, due_at - interval '28 days'
       FROM seed
     ),
     ins_attachments AS (
       INSERT INTO public.subscription_renewal_attachments(order_id, subscription_id, purchase_facts, completed_at)
       SELECT id, id, '{"templateId":"bench-template","shippingAmountMinor":0,"acquisitionRef":"bench-acq"}'::jsonb, due_at - interval '28 days'
       FROM seed
     ),
     ins_terms AS (
       INSERT INTO public.subscription_renewal_terms(
         subscription_id, next_cycle_number, currency_code, stock_source_key,
         settlement_channel_key, unattended_charge_authorized_at, authorization_ref
       )
       SELECT id, 1, 'XXX', $3, 'benchmark', $2::timestamptz, 'frozen-mandate' FROM seed
     )
     INSERT INTO public.subscription_renewal_term_lines(subscription_id, line_ordinal, sku, quantity, unit_amount_minor)
     SELECT id, 1, $4, 2, 100 FROM seed`,
    [cycles, AT, sourceKey, sku],
  );

  await admin.query(
    "ANALYZE public.clients; ANALYZE public.subscriptions; ANALYZE public.subscription_cycles; ANALYZE public.commerce_orders; ANALYZE public.subscription_activations; ANALYZE public.subscription_renewal_terms; ANALYZE public.subscription_renewal_term_lines; ANALYZE public.subscription_renewal_operations; ANALYZE public.fulfillment_stock_current",
  );
}

async function measureSelector(admin: Pool, batchLimit: number, samples: number) {
  const def = (await admin.query("SELECT pg_get_functiondef($1::regprocedure) AS body", [NORMAL_DUE_SIGNATURE])).rows[0].body as string;
  const body = (await admin.query("SELECT prosrc FROM pg_proc WHERE oid = $1::regprocedure", [NORMAL_DUE_SIGNATURE])).rows[0].prosrc as string;
  const explainSql = body
    .replace(/\bp_limit\b/gu, "$1::integer")
    .replace(/\bp_now\b/gu, "$2::timestamptz")
    .trim()
    .replace(/;$/u, "");

  const elapsed: number[] = [];
  let lastPlan: {
    "Node Type"?: string;
    "Shared Hit Blocks"?: number;
    "Shared Read Blocks"?: number;
    "Actual Rows"?: number;
    "Actual Total Time"?: number;
  } | null = null;
  let lastPlanningMs = 0;

  for (let i = 0; i <= samples; i++) {
    const report = (
      await admin.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${explainSql}`, [batchLimit, AS_OF])
    ).rows[0]["QUERY PLAN"][0];
    if (i > 0) {
      elapsed.push(Number(report["Execution Time"]));
      lastPlanningMs = Number(report["Planning Time"]);
      lastPlan = report.Plan;
    }
  }

  return {
    functionSha256: digest(def),
    samplesMs: elapsed.map(round),
    medianMs: round(median(elapsed)),
    maxMs: round(Math.max(...elapsed)),
    planningMs: round(lastPlanningMs),
    sharedHitBlocks: lastPlan?.["Shared Hit Blocks"] ?? null,
    sharedReadBlocks: lastPlan?.["Shared Read Blocks"] ?? null,
    actualRows: lastPlan?.["Actual Rows"] ?? null,
    rootNodeType: lastPlan?.["Node Type"] ?? null,
  };
}

async function measureBacklogAgeSeconds(pool: Pool): Promise<{ dueCount: number; oldestAgeSeconds: number | null }> {
  const row = (
    await pool.query(
      `SELECT
         count(*)::integer AS due_count,
         EXTRACT(EPOCH FROM ($1::timestamptz - MIN(next_cycle_at)))::double precision AS oldest_age_seconds
       FROM public.subscriptions
       WHERE status = 'active' AND next_cycle_at <= $1::timestamptz`,
      [AS_OF],
    )
  ).rows[0];
  return {
    dueCount: Number(row.due_count),
    oldestAgeSeconds: row.oldest_age_seconds == null ? null : round(Number(row.oldest_age_seconds)),
  };
}

type ScenarioResult = {
  rttMs: number;
  batches: number;
  batchLimit: number;
  settledCount: number;
  totalWallMs: number;
  dbQueryMs: number;
  dbQueryCount: number;
  selectorMs: number;
  providerRttMs: number;
  providerCallCount: number;
  otherOverheadMs: number;
  dbSharePct: number;
  providerSharePct: number;
  drainRatePerSec: number;
  projectedFullBacklogSeconds: number;
  backlogAgeBeforeSeconds: number | null;
  backlogAgeAfterSeconds: number | null;
  batchWallMs: number[];
};

async function runRttScenario(
  runtimePool: Pool,
  adminPool: Pool,
  cycles: number,
  batchLimit: number,
  batches: number,
  rttMs: number,
): Promise<ScenarioResult> {
  const codec = createNativeRenewalCodec();
  const now = () => AS_OF;

  let dbQueryMs = 0;
  let dbQueryCount = 0;
  let selectorMs = 0;
  let providerRttMs = 0;
  let providerCallCount = 0;
  let lastQueryError: string | null = null;

  const timedQuery = async (target: Pool | PoolClient, sql: string, params?: readonly unknown[]): Promise<QueryResult> => {
    const start = performance.now();
    try {
      const res = await target.query(sql, params as unknown[] | undefined);
      const dt = performance.now() - start;
      dbQueryMs += dt;
      dbQueryCount += 1;
      if (sql.includes("subscription_stock_wait_normal_due")) {
        selectorMs += dt;
      }
      return res;
    } catch (error) {
      lastQueryError = `${error instanceof Error ? error.message : String(error)} | sql=${sql.slice(0, 140)}`;
      throw error;
    }
  };

  const executor = {
    query: (sql: string, params?: readonly unknown[]) => timedQuery(runtimePool, sql, params),
  };

  const withTransaction = async <T>(work: (db: { query: typeof executor.query }) => Promise<T>): Promise<T> => {
    const client = await runtimePool.connect();
    try {
      await timedQuery(client, "BEGIN");
      const wrapped = {
        query: (sql: string, params?: readonly unknown[]) => timedQuery(client, sql, params),
      };
      const result = await work(wrapped);
      await timedQuery(client, "COMMIT");
      return result;
    } catch (error) {
      await timedQuery(client, "ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const attempts = new Map<string, { ref: string; requestFingerprint: string }>();
  const fakeRail: RenewalPaymentRail = {
    async execute(input) {
      const start = performance.now();
      if (rttMs > 0) await delay(rttMs);
      providerRttMs += performance.now() - start;
      providerCallCount += 1;
      const ref = `bench-attempt:${input.executionIdempotencyKey}`;
      attempts.set(input.paymentIntentId, { ref, requestFingerprint: input.requestFingerprint });
      return { status: "succeeded", externalAttemptRef: ref };
    },
    async findExternalAttempt(input) {
      return attempts.get(input.settlementIntentId)?.ref ?? null;
    },
    async readOutcome(input) {
      const recorded = attempts.get(input.settlementIntentId);
      const opRow = (
        await adminPool.query(
          `SELECT op.id, op.operation_fingerprint
           FROM public.subscription_renewal_operations op
           JOIN public.commerce_settlement_intents si ON si.renewal_operation_id = op.id
           WHERE si.id = $1::uuid`,
          [input.settlementIntentId],
        )
      ).rows[0];
      assert(opRow, `missing renewal operation for settlement_intent_id=${input.settlementIntentId}`);
      return {
        status: "succeeded",
        disposition: "observed",
        operationId: String(opRow.id),
        eventKey: `bench-event:${String(opRow.id)}`,
        requestFingerprint: recorded?.requestFingerprint ?? String(opRow.operation_fingerprint),
        verifiedEvidenceRef: `bench-evidence:${input.externalAttemptRef}`,
        externalAttemptRef: input.externalAttemptRef,
        occurredAt: AS_OF,
        observedAt: AS_OF,
        firstRecordedAt: AS_OF,
        amountMinor: input.amountMinor,
        currency: input.currency,
        reason: null,
      };
    },
  };

  const unexpectedRetry = (): never => {
    throw new Error("unexpected retry during throughput benchmark");
  };

  const binding = createNativeSubscriptionBinding({
    enabled: true,
    batchLimit,
    population: `bench-rtt-${rttMs}`,
    executor,
    withTransaction,
    withRunLease: async (_population, work) => work(),
    codec,
    settlement: (db) => createPostgresRenewalSettlementPort(db, codec, withTransaction),
    inventory: createPostgresRenewalReservationPort(executor),
    policy: createSandboxRenewalPolicy("bench-method-1"),
    paymentRails: {
      resolve: (channel) => (channel === "benchmark" ? fakeRail : null),
    },
    retry: {
      readFrozenMandate: unexpectedRetry,
      retryInput: unexpectedRetry,
      payments: { execute: unexpectedRetry, readOutcome: unexpectedRetry },
      recoveredTemplate: "recovered",
    },
    failureTemplate: "failed",
    recoveryPath: "/recover",
    workerId: `bench-worker-rtt-${rttMs}`,
    now,
    catalogue: { version: "benchmark", migration: "benchmark" },
    readiness: async () => ({
      state: "ready",
      candidate: {
        artifact: "benchmark",
        configuration: "benchmark",
        environment: "disposable",
        database: "benchmark",
        schema: "complete",
      },
      loadedPackages: [],
      issues: [],
    }),
  });

  const before = await measureBacklogAgeSeconds(adminPool);
  const batchWallMs: number[] = [];
  let settledCount = 0;

  for (let b = 0; b < batches; b++) {
    const start = performance.now();
    const run = await binding.services.run();
    const wall = performance.now() - start;
    assert(run !== null && "renewals" in run, `expected run lease acquisition to succeed, got ${JSON.stringify(run)}`);
    const succeeded = run.renewals.filter((r) => r.status === "succeeded").length;
    assert.equal(
      succeeded,
      batchLimit,
      `expected ${batchLimit} succeeded renewals in batch ${b + 1} (rtt=${rttMs}ms), got ${succeeded} (dbQueryCount=${dbQueryCount}, providerCallCount=${providerCallCount}, lastQueryError=${lastQueryError}, statuses: ${JSON.stringify(run.renewals.slice(0, 3))})`,
    );
    settledCount += succeeded;
    batchWallMs.push(round(wall));
  }

  const after = await measureBacklogAgeSeconds(adminPool);
  const totalWallMs = batchWallMs.reduce((acc, v) => acc + v, 0);
  const otherOverheadMs = Math.max(0, totalWallMs - dbQueryMs - providerRttMs);
  const drainRatePerSec = totalWallMs > 0 ? settledCount / (totalWallMs / 1000) : 0;
  const projectedFullBacklogSeconds = drainRatePerSec > 0 ? cycles / drainRatePerSec : 0;

  return {
    rttMs,
    batches,
    batchLimit,
    settledCount,
    totalWallMs: round(totalWallMs),
    dbQueryMs: round(dbQueryMs),
    dbQueryCount,
    selectorMs: round(selectorMs),
    providerRttMs: round(providerRttMs),
    providerCallCount,
    otherOverheadMs: round(otherOverheadMs),
    dbSharePct: round((dbQueryMs / totalWallMs) * 100),
    providerSharePct: round((providerRttMs / totalWallMs) * 100),
    drainRatePerSec: round(drainRatePerSec),
    projectedFullBacklogSeconds: round(projectedFullBacklogSeconds),
    backlogAgeBeforeSeconds: before.oldestAgeSeconds,
    backlogAgeAfterSeconds: after.oldestAgeSeconds,
    batchWallMs,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      cycles: { type: "string", default: "10000" },
      "batch-limit": { type: "string", default: "50" },
      batches: { type: "string", default: "2" },
      "rtt-ms": { type: "string", default: "0,50,200" },
      samples: { type: "string", default: "5" },
      output: { type: "string" },
    },
  });

  const cycles = integerOption(values.cycles, 100, 200_000, "cycles");
  const batchLimit = integerOption(values["batch-limit"], 1, 500, "batch-limit");
  const batches = integerOption(values.batches, 1, 50, "batches");
  const samples = integerOption(values.samples, 1, 20, "samples");
  const rtts = rttListOption(values["rtt-ms"]);

  const neededCycles = batchLimit * batches * rtts.length;
  if (cycles < neededCycles) {
    throw new Error(`--cycles (${cycles}) must be >= batch-limit * batches * rtt scenarios (${neededCycles})`);
  }

  let resource: PostgresContainer | undefined;
  let adminPool: Pool | undefined;
  let runtimePool: Pool | undefined;

  try {
    const password = "native-renewal-bench";
    resource = await runPostgresContainer({ name: `native-renewal-bench-${process.pid}`, password, durability: "default" });
    const ready = await waitForPostgresTcpReady(resource.connectionString);
    if (!ready) throw new Error("native renewal benchmark PostgreSQL unavailable");

    adminPool = new Pool({
      connectionString: resource.connectionString,
      options: qualifiedPostgresStartupOptions(installation),
      max: 4,
    });

    await adminPool.query(
      `CREATE ROLE ${installation.runtimeLogin} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOBYPASSRLS;
       CREATE ROLE ${installation.restoreLogin} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOBYPASSRLS;`,
    );

    await createPostgresMigrationRunner(
      { connectionString: resource.connectionString },
      { installation, poolFactory: () => adminPool! },
    ).apply();

    const seedStart = performance.now();
    await seedDataset(adminPool, cycles);
    const seedMs = round(performance.now() - seedStart);

    const serverSettings = (
      await adminPool.query(
        "SELECT name, setting FROM pg_settings WHERE name IN ('server_version', 'jit', 'shared_buffers', 'work_mem') ORDER BY name",
      )
    ).rows as Array<{ name: string; setting: string }>;

    const selector = await measureSelector(adminPool, batchLimit, samples);

    runtimePool = new Pool({
      connectionString: runtimeConnectionString(resource.connectionString, password),
      max: 8,
    });

    const scenarios: ScenarioResult[] = [];
    for (const rttMs of rtts) {
      scenarios.push(await runRttScenario(runtimePool, adminPool, cycles, batchLimit, batches, rttMs));
    }

    const report = {
      benchmark: "native-renewal-throughput",
      measuredAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpus: availableParallelism(),
      },
      postgres: Object.fromEntries(serverSettings.map((row) => [row.name, row.setting])),
      dataset: { cycles, batchLimit, batches, seedMs },
      selector,
      scenarios,
    };

    const json = JSON.stringify(report, null, 2);
    if (values.output) {
      writeFileSync(values.output, `${json}\n`, "utf8");
    }
    process.stdout.write(`${json}\n`);
  } finally {
    await runtimePool?.end().catch(() => {});
    await closePostgres(resource, adminPool);
  }
}

await main();
