/** Keep active subscriptions active on dunning exhaustion (invariant repair). */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const forward = "db/platform/migrations/20261021120000_dunning_lifecycle_active_repair.sql";
const expectedSha = "8918204df731aade89976953f8434afe08cfcbe84b6382a51728b9d14100e7ea";
const prefixInventory = "3c7cf9a9193257d64497ea9790f6a90b5b3a15713e0df5ef4638f451a7cff107";
const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const units = [manifest.baseline, ...manifest.forward];
const index = units.findIndex(unit => unit.file === forward);
const clientId = "d7100000-0000-4000-8000-000000000001";
const subscriptionId = "d7100000-0000-4000-8000-000000000002";
const cycleId = "d7100000-0000-4000-8000-000000000003";
const caseId = "d7100000-0000-4000-8000-000000000004";
const at = "2026-10-21T12:00:00.000Z", nextRetry = "2026-10-22T12:00:00.000Z";
const signature = "public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text)";
const failureSql = "SELECT public.dunning_lifecycle_handle_failure($1,$2,$3,$4,$5,$6,$7,$8) AS result";
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let fresh: Pool, upgrade: Pool, db: PoolClient | undefined, prefixRoot: string | undefined;
let available = false;
let prefixRows: Awaited<ReturnType<typeof snapshot>>;
let prefixAcl: Awaited<ReturnType<typeof privileges>>;
let freshApplied: string[], upgradeApplied: string[];

it("binds the unchanged forward bytes and excludes subscription pause/expiry writes without PostgreSQL", () => {
  const bytes = readFileSync(forward), sql = bytes.toString("utf8");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha);
  expect(manifest.forward.filter(unit => unit.file === forward)).toEqual([{ file: forward, sha256: expectedSha }]);
  expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?subscription_pause_windows\b/iu);
  expect(sql).not.toMatch(/UPDATE\s+public\.subscriptions\b/iu);
  expect(sql).not.toMatch(/\bstatus\s*=\s*'expired'/iu);
});

function runner(pool: Pool, root = process.cwd()) {
  return createPostgresMigrationRunner({ connectionString: "injected" }, { root, poolFactory: () => pool });
}

async function snapshot(connection: Pool | PoolClient) {
  const result: Record<string, unknown> = {};
  for (const table of ["subscriptions", "subscription_cycles", "subscription_dunning_cases", "subscription_dunning_notifications", "subscription_events", "subscription_pause_windows"]) {
    result[table] = (await connection.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}

async function privileges(connection: Pool | PoolClient) {
  return (await connection.query(`SELECT p.proacl::text AS acl, p.prosecdef, p.proconfig,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
    FROM pg_proc p WHERE p.oid = $1::regprocedure`, [signature])).rows;
}

async function asRuntime(sql: string, values: unknown[]) {
  await db!.query("SET LOCAL ROLE dunning_repair_runtime");
  try { return (await db!.query(sql, values)).rows[0].result; }
  finally { await db!.query("RESET ROLE"); }
}

function fail(next: string | null = null, attempt = 3) {
  // A lower supplied attempt must not lower the stored last rung (4) on exhaustion.
  return asRuntime(failureSql, [caseId, at, "temporary", "synthetic refusal", attempt, next, "synthetic-notice", "/account/recovery"]);
}

describe("real PostgreSQL portable dunning forward", () => {
  beforeAll(async () => {
    available = await dockerAvailable();
    if (!available) return;
    expect(index).toBe(71);
    // Preserve the exact current-main prefix, including its independently pinned inventory.
    const prefix = { ...manifest, forward: manifest.forward.slice(0, index - 1), objectInventorySha256: prefixInventory };
    prefixRoot = mkdtempSync(join(tmpdir(), "dunning-repair-prefix-"));
    for (const unit of [prefix.baseline, ...prefix.forward]) {
      const path = join(prefixRoot, unit.file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(unit.file));
    }
    mkdirSync(join(prefixRoot, "config"));
    writeFileSync(join(prefixRoot, "config/platform-migration-manifest.json"), JSON.stringify(prefix));
    for (const name of ["fresh", "upgrade"]) {
      const container = await runPostgresContainer({ name: `dunning-repair-${name}-${process.pid}`, password: "synthetic-conformance" });
      containers.push(container);
      if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Disposable dunning PostgreSQL unavailable");
      pools.push(new Pool({ connectionString: container.connectionString }));
    }
    [fresh, upgrade] = pools;
    await runner(upgrade, prefixRoot).apply();
    await upgrade.query("INSERT INTO public.clients(id,email) VALUES ($1,'subscriber@example.invalid')", [clientId]);
    await upgrade.query(`INSERT INTO public.subscriptions(id,client_id,status,cadence_days,next_cycle_at,started_at)
      VALUES ($1,$2,'active',28,'2026-11-18T12:00:00Z','2026-09-23T12:00:00Z')`, [subscriptionId, clientId]);
    await upgrade.query(`INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status)
      VALUES ($1,$2,'2026-10-21T12:00:00Z','payment_pending')`, [cycleId, subscriptionId]);
    await upgrade.query(`INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,retry_attempt,next_retry_at,idempotency_key)
      VALUES ($1,$2,$3,$4,4,$5,'synthetic:last-rung')`, [caseId, subscriptionId, cycleId, clientId, at]);
    prefixRows = await snapshot(upgrade);
    prefixAcl = await privileges(upgrade);
    upgradeApplied = (await runner(upgrade).apply()).applied;
    freshApplied = (await runner(fresh).apply()).applied;
  }, 120_000);

  beforeEach(async context => {
    if (!available) context.skip("Docker unavailable; real PostgreSQL proof did not run");
    db = await upgrade.connect();
    await db.query("BEGIN");
    // Explicit synthetic application lane: no subscription, cycle or pause-window writes.
    // These test grants demonstrate invoker behavior, not shipped runtime provisioning.
    await db.query(`CREATE ROLE dunning_repair_runtime NOLOGIN;
      GRANT USAGE ON SCHEMA public TO dunning_repair_runtime;
      GRANT SELECT, UPDATE ON public.subscription_dunning_cases TO dunning_repair_runtime;
      GRANT SELECT, INSERT, UPDATE ON public.subscription_dunning_notifications TO dunning_repair_runtime;
      GRANT SELECT, INSERT ON public.subscription_events TO dunning_repair_runtime;
      GRANT SELECT ON public.commerce_orders TO dunning_repair_runtime;
      GRANT SELECT, UPDATE ON public.commerce_checkout_recovery_tokens TO dunning_repair_runtime;
      GRANT EXECUTE ON FUNCTION ${signature},
        public.dunning_lifecycle_queue_notice(uuid,text,text,integer,text),
        public.dunning_lifecycle_record_recovery(uuid,timestamptz,text) TO dunning_repair_runtime`);
  });

  afterEach(async () => {
    if (db) { await db.query("ROLLBACK"); db.release(); db = undefined; }
  });
  afterAll(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    await Promise.all(containers.map(container => container.remove()));
    if (prefixRoot) rmSync(prefixRoot, { recursive: true, force: true });
  });

  it("installs the full catalogue at the next ledger position and replays without writes", async () => {
    expect(freshApplied).toEqual(units.map(unit => unit.file));
    for (const pool of pools) {
      const ledger = (await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
      expect(ledger.map(({ catalog_path, sha256, position }) => ({ catalog_path, sha256, position })))
        .toEqual(units.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })));
      const rows = await snapshot(pool);
      expect(await runner(pool).apply()).toEqual({ applied: [] });
      expect((await runner(pool).status()).pending).toEqual([]);
      expect((await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows).toEqual(ledger);
      expect(await snapshot(pool)).toEqual(rows);
    }
  });

  it("upgrades the exact prefix without row rewrites, keeps the last-rung case open and emits one final notice/event", async () => {
    expect(upgradeApplied).toEqual([forward]);
    expect(await snapshot(db!)).toEqual(prefixRows);
    const result = await fail();
    expect(result).toEqual({ caseId, caseStatus: "open", notificationId: expect.any(String), retryAttempt: 4, paused: false, pauseWindowId: null, terminal: true });
    expect((await db!.query("SELECT status FROM public.subscriptions WHERE id=$1", [subscriptionId])).rows).toEqual([{ status: "active" }]);
    expect((await db!.query("SELECT status,next_retry_at,retry_attempt,expired_at FROM public.subscription_dunning_cases WHERE id=$1", [caseId])).rows)
      .toEqual([{ status: "open", next_retry_at: null, retry_attempt: 4, expired_at: null }]);
    expect((await db!.query("SELECT notification_kind FROM public.subscription_dunning_notifications WHERE case_id=$1", [caseId])).rows)
      .toEqual([{ notification_kind: "payment_expired" }]);
    expect((await db!.query("SELECT event_type FROM public.subscription_events WHERE subscription_id=$1", [subscriptionId])).rows)
      .toEqual([{ event_type: "dunning_ladder_exhausted" }]);
    expect((await db!.query("SELECT * FROM public.subscription_pause_windows")).rows).toEqual([]);
  });

  it("preserves all subscription and cycle dates and never stacks a cycle", async () => {
    const before = await snapshot(db!);
    await fail(null, 5);
    const after = await snapshot(db!);
    expect(after.subscriptions).toEqual(before.subscriptions);
    expect(after.subscription_cycles).toEqual(before.subscription_cycles);
    expect((await db!.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1", [subscriptionId])).rows).toEqual([{ count: 1 }]);
    expect((await db!.query("SELECT retry_attempt FROM public.subscription_dunning_cases WHERE id=$1", [caseId])).rows).toEqual([{ retry_attempt: 5 }]);
  });

  it("replays NULL without duplicate notice/event or pause and still schedules a non-NULL retry", async () => {
    const first = await fail();
    const before = await snapshot(db!);
    expect(await fail(null, 1)).toEqual(first);
    const repeated = await snapshot(db!);
    for (const table of ["subscriptions", "subscription_cycles", "subscription_dunning_notifications", "subscription_events", "subscription_pause_windows"]) {
      expect(repeated[table]).toEqual(before[table]);
    }
    expect(await fail(nextRetry, 5)).toMatchObject({ caseStatus: "open", retryAttempt: 5, paused: false, terminal: false });
    expect((await db!.query("SELECT next_retry_at,retry_attempt FROM public.subscription_dunning_cases WHERE id=$1", [caseId])).rows)
      .toEqual([{ next_retry_at: new Date(nextRetry), retry_attempt: 5 }]);
    expect((await db!.query("SELECT notification_kind FROM public.subscription_dunning_notifications WHERE case_id=$1 ORDER BY notification_kind", [caseId])).rows)
      .toEqual([{ notification_kind: "payment_expired" }, { notification_kind: "payment_failed" }]);
    expect((await db!.query("SELECT count(*)::integer AS count FROM public.subscription_events")).rows).toEqual([{ count: 1 }]);
    expect((await db!.query("SELECT * FROM public.subscription_pause_windows")).rows).toEqual([]);
  });

  it.each(["recovered", "expired", "cancelled"])("returns terminal for a %s case without writes", async status => {
    await db!.query(`UPDATE public.subscription_dunning_cases SET status=$2,
      recovered_at=CASE WHEN $2='recovered' THEN $3::timestamptz END,
      expired_at=CASE WHEN $2='expired' THEN $3::timestamptz END WHERE id=$1`, [caseId, status, at]);
    const before = await snapshot(db!);
    const writes = async () => (await db!.query("SELECT relname,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_xact_user_tables ORDER BY relname")).rows;
    const beforeWrites = await writes();
    for (const next of [null, nextRetry]) {
      expect(await fail(next)).toEqual({ caseId, caseStatus: status, paused: false, terminal: true });
    }
    expect(await snapshot(db!)).toEqual(before);
    expect(await writes()).toEqual(beforeWrites);
  });

  it("recovers the exhausted open case through the existing recovery path", async () => {
    await fail();
    const sql = "SELECT public.dunning_lifecycle_record_recovery($1,$2,$3) AS result";
    expect(await asRuntime(sql, [caseId, at, "synthetic-recovered"]))
      .toMatchObject({ caseId, caseStatus: "recovered", replayed: false });
    expect((await db!.query("SELECT status,recovered_at FROM public.subscription_dunning_cases WHERE id=$1", [caseId])).rows)
      .toEqual([{ status: "recovered", recovered_at: new Date(at) }]);
    expect(await asRuntime(sql, [caseId, at, "synthetic-recovered"]))
      .toEqual({ caseId, caseStatus: "recovered", replayed: true });
    const after = await snapshot(db!);
    expect(after.subscriptions).toEqual(prefixRows.subscriptions);
    expect(after.subscription_cycles).toEqual(prefixRows.subscription_cycles);
    expect((await db!.query("SELECT notification_kind,status FROM public.subscription_dunning_notifications ORDER BY notification_kind")).rows)
      .toEqual([{ notification_kind: "payment_expired", status: "skipped" }, { notification_kind: "payment_recovered", status: "queued" }]);
  });

  it("preserves invoker/search-path/ACL properties and denies actual browser-role execution", async () => {
    for (const pool of pools) {
      expect(await privileges(pool)).toEqual(prefixAcl);
      expect(await privileges(pool)).toEqual([{ acl: expect.any(String), prosecdef: false, proconfig: ["search_path=public, pg_catalog"], anon: false, authenticated: false }]);
      const browser = await pool.connect();
      try {
        for (const role of ["anon", "authenticated"]) {
          await browser.query("BEGIN");
          try {
            await browser.query(`SET LOCAL ROLE ${role}`);
            await expect(browser.query(failureSql, [caseId, at, "temporary", "synthetic", 4, null, "synthetic", "/account/recovery"]))
              .rejects.toMatchObject({ code: "42501", message: "permission denied for function dunning_lifecycle_handle_failure" });
          } finally { await browser.query("ROLLBACK"); }
        }
      } finally { browser.release(); }
    }
  });
});
