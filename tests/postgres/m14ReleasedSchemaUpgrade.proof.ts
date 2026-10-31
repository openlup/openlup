import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool, type PoolConfig } from "pg";
import assert from "node:assert/strict";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import type { QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresDeliveryAlignmentPort } from "@openlup/platform/fulfillment";
import { createPostgresPaymentTruthPort } from "@openlup/platform/payments";
import { executor, fixture, openCase } from "../helpers/fulfillmentNative.js";
import { closePostgres, dockerAvailable, runPostgresContainer,
  waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
const releasedPrefixSha256 = "ab245e60be9ddee31364626c57ec902a111dfc1a6baa1d07479d84ab2ea3fc34";
const releasedInventorySha256 = "93a469a5e284dc942cef26b92fe9cb2770590383aedbd9351b04fedb8b24c0e9";
const backfillPath = "db/platform/migrations/20261022190000_invoicing_durable_duties.sql";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const childPath = fileURLToPath(new URL("./m14ReleasedSchemaUpgradeChild.ts", import.meta.url));

async function waitUntil(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`released schema upgrade did not reach ${label}`);
}

async function killed(child: ChildProcess) {
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGKILL");
  assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
}

function startChild(database: PoolConfig, mode: "inside" | "between", marker: string, installation?: QualifiedAdminPostgresInstallation) {
  const child = spawn(process.execPath, ["--import", "tsx", childPath, mode, marker],
    { env: { TMPDIR: dirname(marker) }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.end(JSON.stringify({ database, installation }));
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  return { child, output: () => output };
}

export async function runReleasedSchemaUpgradeProof(input: { database?: PoolConfig; previousApplicationPath?: string; requirePreviousApplication?: boolean;
  installation?: QualifiedAdminPostgresInstallation; rolePrefix?: string } = {}) {
  if (!input.database && !await dockerAvailable()) throw new Error("Released schema upgrade requires PostgreSQL 16");
  const selected = input.installation ? selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
    "qualified-admin", { roleMode: input.installation.roleMode }) : manifest;
  const selectedUnits = [selected.baseline, ...selected.forward];
  const units = selectedUnits;
  const releasedUnits = input.installation ? units.findIndex(unit => unit.file === backfillPath) : 77;
  assert.equal(units.length, input.installation ? 92 : 89);
  assert.ok(releasedUnits > 0);
  assert.equal(units[releasedUnits]!.file, backfillPath);
  const prefix = { baseline: units[0], forward: units.slice(1, releasedUnits) };
  if (!input.installation) assert.equal(sha256(JSON.stringify(prefix)), releasedPrefixSha256);
  for (const unit of units) assert.equal(sha256(readFileSync(unit.file)), unit.sha256);

  const container = input.database ? undefined : await runPostgresContainer({ name: `m14-released-upgrade-${process.pid}`,
    password: "synthetic-conformance" });
  const connectionString = input.database?.connectionString ?? container!.connectionString;
  let pool: Pool | undefined;
  let previousAppPool: Pool | undefined;
  let previousAppRole: string | undefined;
  let root: string | undefined;
  let inside: ChildProcess | undefined;
  let between: ChildProcess | undefined;
  try {
    if (!input.database && !await waitForPostgresTcpReady(connectionString)) throw new Error("PostgreSQL TCP unavailable");
    pool = new Pool({ ...input.database, connectionString: connectionString });
    assert.match((await pool.query("SHOW server_version_num")).rows[0].server_version_num, /^16/);
    root = mkdtempSync(join(tmpdir(), "m14-released-prefix-"));
    for (const unit of units.slice(0, releasedUnits)) {
      const path = join(root, unit.file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(unit.file));
    }
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify({
      schemaVersion: 1, ...prefix, objectInventorySha256: releasedInventorySha256,
    }));
    if (input.installation) {
      let begins = 0;
      const prefixPool = { connect: async () => {
        const actual = await pool!.connect();
        return { query: (sql: string, values?: unknown[]) => {
          if (sql === "BEGIN" && ++begins === releasedUnits + 1) throw new Error("restricted prefix boundary");
          return actual.query(sql, values);
        }, release: actual.release.bind(actual) };
      } } as unknown as Pool;
      const predecessor = createPostgresMigrationRunner({ connectionString }, { installation: input.installation, poolFactory: () => prefixPool });
      await assert.rejects(predecessor.apply(), /restricted prefix boundary/u);
      assert.equal((await predecessor.status()).applied.length, releasedUnits);
    } else {
      const predecessor = createPostgresMigrationRunner({ connectionString }, { root, poolFactory: () => pool! });
      assert.equal((await predecessor.apply()).applied.length, releasedUnits);
      assert.deepEqual((await predecessor.status()).pending, []);
    }

    const retained = await fixture(pool);
    const intent = randomUUID(), settlementOrder = randomUUID();
    const seeded = await pool.connect();
    try {
      await seeded.query("BEGIN");
      await seeded.query(`INSERT INTO public.commerce_orders
        (id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',900)`,
      [settlementOrder, retained.client]);
      await seeded.query(`INSERT INTO public.commerce_order_items
        (order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
        VALUES($1,1,1,900,900)`, [settlementOrder]);
      await seeded.query("COMMIT");
    } catch (error) { await seeded.query("ROLLBACK"); throw error; } finally { seeded.release(); }
    await pool.query(`INSERT INTO public.commerce_settlement_intents
      (id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
      VALUES($1,$2,'fixture',900,'XXX',$3)`, [intent, settlementOrder, `open-${intent}`]);
    const paymentInput = { sourceEventId: `released:${intent}`, idempotencyKey: `released-${intent}`,
      settlementIntentId: intent, outcome: "captured" as const, amountMinor: 900, currency: "XXX",
      occurredAt: "2026-08-12T12:00:00Z", failure: null,
      evidence: { sourceKind: "accepted_event" as const, sourceReference: `released:${intent}`,
        observedStatus: "captured", observedAt: "2026-08-12T12:00:00Z", payloadFingerprint: "a".repeat(64) } };
    const paymentOptions = { dunningTemplateSlug: "payment_failed", recoveryUrlPath: "/recover",
      recoveryTemplateSlug: "payment_recovered" };
    const paymentPort = createPostgresPaymentTruthPort(executor(pool), paymentOptions);
    const accepted = await paymentPort.ingestEvent(paymentInput);
    assert.partialDeepStrictEqual(accepted.event, { state: "settled", replayed: false });
    await pool.query(`INSERT INTO public.fulfillment_shipment_operations
      (shipment_id,order_id,operation_type,idempotency_key,payload)
      VALUES($1,$2,'shipment_advanced',$3,'{"toStatus":"handed_over"}')`,
    [retained.shipment, retained.order, `handoff-${retained.shipment}`]);
    const sources = (await pool.query(`SELECT 'paid' AS source_kind,id AS source_id FROM public.commerce_settlement_transitions
      UNION ALL SELECT 'handoff',id FROM public.fulfillment_shipment_operations ORDER BY source_kind,source_id`)).rows;
    assert.ok(sources.length >= 2);
    const priorOrder = (await pool.query("SELECT * FROM public.commerce_orders WHERE id=$1", [retained.order])).rows;
    const priorSubscription = (await pool.query("SELECT * FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows;
    const ledger = async () => (await pool!.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows;
    const expectedLedger = units.map((unit, position) => ({
      catalog_path: unit.file, sha256: unit.sha256, position,
    }));
    assert.deepEqual(await ledger(), expectedLedger.slice(0, releasedUnits));

    // The child enters the real backfill SQL while the source relation is held.
    // SIGKILL then aborts its open unit transaction, including CREATE TABLE.
    const blocker = await pool.connect();
    try {
      const insideMarker = join(root, "inside-marker");
      const running = input.installation ? startChild({ ...input.database, connectionString }, "inside", insideMarker, input.installation) : undefined;
      if (running) {
        inside = running.child;
        await waitUntil(() => existsSync(insideMarker), "restricted admission before backfill");
      }
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE public.commerce_settlement_transitions IN ACCESS EXCLUSIVE MODE");
      const executing = running ?? startChild({ ...input.database, connectionString }, "inside", insideMarker);
      inside = executing.child;
      if (input.installation) writeFileSync(`${insideMarker}.release`, "blocker-held");
      await waitUntil(async () => Number((await pool!.query(`SELECT count(*) FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND query LIKE '%CREATE TABLE public.invoicing_cutover%'`)).rows[0].count) === 1,
      "backfill unit lock wait");
      await killed(inside);
      inside = undefined;
      assert.equal(executing.output(), "");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    assert.deepEqual(await ledger(), expectedLedger.slice(0, releasedUnits));
    assert.equal((await pool.query("SELECT to_regclass('public.invoicing_cutover') AS table_name")).rows[0].table_name, null);

    // The first real forward commits. A test transport hook parks before the
    // next BEGIN so the second SIGKILL is unambiguously between units.
    const marker = join(root, "between-marker");
    const running = startChild({ ...input.database, connectionString: connectionString }, "between", marker, input.installation);
    between = running.child;
    await waitUntil(() => existsSync(marker), "between-unit barrier");
    assert.deepEqual(await ledger(), expectedLedger.slice(0, releasedUnits + 1));
    await killed(between);
    between = undefined;
    assert.equal(running.output(), "");
    assert.deepEqual((await pool.query(`SELECT source_kind,source_id FROM public.invoicing_cutover
      ORDER BY source_kind,source_id`)).rows, sources);
    assert.deepEqual((await pool.query("SELECT * FROM public.commerce_orders WHERE id=$1", [retained.order])).rows, priorOrder);

    assert.deepEqual((await pool.query("SELECT * FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows, priorSubscription);

    const current = createPostgresMigrationRunner({ connectionString: connectionString },
      { installation: input.installation, poolFactory: () => pool! });
    assert.deepEqual((await current.apply()).applied, units.slice(releasedUnits + 1).map(unit => unit.file));
    assert.deepEqual(await ledger(), expectedLedger);
    assert.deepEqual(await current.apply(), { applied: [] });
    assert.deepEqual((await current.status()).pending, []);
    assert.deepEqual((await pool.query(`SELECT source_kind,source_id FROM public.invoicing_cutover
      ORDER BY source_kind,source_id`)).rows, sources);
    assert.deepEqual((await pool.query("SELECT * FROM public.commerce_orders WHERE id=$1", [retained.order])).rows, priorOrder);

    // An optional pinned local package supplies actual previous application
    // code. The CI path still proves the complete database upgrade offline.
    const releasedPayments = input.previousApplicationPath ?? join(process.cwd(),
      ".context/scratch/m14-schema-upgrade/previous-app/node_modules/@openlup/platform/dist/payments/index.js");
    if (input.requirePreviousApplication) assert.ok(existsSync(releasedPayments), "previous application package required");
    if (existsSync(releasedPayments)) {
      const releasedPackage = JSON.parse(readFileSync(join(dirname(releasedPayments), "..", "..", "package.json"), "utf8"));
      assert.partialDeepStrictEqual(releasedPackage, { name: "@openlup/platform", version: "0.23.0" });
      const previous = await import(pathToFileURL(releasedPayments).href);
      const role = input.rolePrefix ? `${input.rolePrefix}_previous` : `m14_previous_app_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(32).toString("hex");
      await pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      previousAppRole = role;
      const oldAppUrl = new URL(connectionString);
      oldAppUrl.username = role;
      oldAppUrl.password = password;
      previousAppPool = new Pool({ ...input.database, connectionString: oldAppUrl.toString() });
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role};
        GRANT SELECT,INSERT,UPDATE ON public.payment_truth_events TO ${role};
        GRANT SELECT ON public.commerce_settlement_intents,public.commerce_orders,
          public.subscription_cycles,public.subscriptions,public.accounting_documents TO ${role};
        GRANT EXECUTE ON FUNCTION public.payment_truth_readback(uuid,boolean),
          public.payment_truth_ingest_event(text,text,text,uuid,text,bigint,text,timestamptz,text,text,jsonb,text,text,text)
          TO ${role}`);
      const previousPort = previous.createPostgresPaymentTruthPort(executor(previousAppPool), paymentOptions);
      assert.partialDeepStrictEqual(await previousPort.readEvent(accepted.event.id), {
        event: { id: accepted.event.id, state: "settled" },
      });
      assert.partialDeepStrictEqual(await previousPort.ingestEvent(paymentInput), {
        event: { id: accepted.event.id, replayed: true, state: "settled" },
      });
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.payment_truth_events WHERE source_event_id=$1",
        [paymentInput.sourceEventId])).rows[0].count, 1);
    }

    // A late customer arrival extends one cycle; its replay cannot stack the
    // extension, and earlier evidence cannot pull a different cycle earlier.
    await openCase(pool, retained);
    const arrival = createPostgresDeliveryAlignmentPort(executor(pool));
    const event = { requestKey: `arrival-${retained.shipment}`, parcelRef: retained.shipment,
      deliveredAt: "2026-09-04T12:00:00Z", evidenceRef: `evidence:${retained.shipment}` as const };
    assert.partialDeepStrictEqual(await arrival.recordArrival(event), { disposition: "aligned",
      nextCycleAt: "2026-10-02T12:00:00.000Z" });
    const afterArrival = (await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows[0].next_cycle_at;
    assert.partialDeepStrictEqual(await arrival.recordArrival(event), { replayed: true });
    assert.deepEqual((await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows[0].next_cycle_at, afterArrival);
    assert.equal(new Date(afterArrival).toISOString(), "2026-10-02T12:00:00.000Z");
    const earlier = await fixture(pool);
    await openCase(pool, earlier);
    const earlierArrival = { requestKey: `arrival-${earlier.shipment}`, parcelRef: earlier.shipment,
      deliveredAt: "2026-07-01T12:00:00Z", evidenceRef: `evidence:${earlier.shipment}` as const };
    assert.partialDeepStrictEqual(await arrival.recordArrival(earlierArrival), { disposition: "aligned",
      nextCycleAt: "2026-08-29T12:00:00.000Z" });
    assert.partialDeepStrictEqual(await arrival.recordArrival(earlierArrival), { replayed: true });
    assert.equal((await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [earlier.subscription])).rows[0].next_cycle_at.toISOString(), "2026-08-29T12:00:00.000Z");
    return { predecessor: input.installation ? "qualified-admin prefix before invoicing backfill; not a released installation lineage" : "0.23.0",
      prefixSha256: sha256(JSON.stringify(prefix)), releasedUnits, currentUnits: units.length, backfillPath,
      insideUnitInterruption: true, betweenUnitInterruption: true, resume: true, replayApplied: 0,
      retainedRows: true, subscriptionInvariant: true, compatibleCodeRollback: existsSync(releasedPayments) };
  } finally {
    if (inside && inside.exitCode === null) inside.kill("SIGKILL");
    if (between && between.exitCode === null) between.kill("SIGKILL");
    try {
      if (previousAppPool) await previousAppPool.end();
    } finally {
      try {
        if (previousAppRole && pool && !input.installation) {
          await pool.query(`DROP OWNED BY ${previousAppRole}`);
          await pool.query(`DROP ROLE ${previousAppRole}`);
        }
      } finally {
        await closePostgres(container, [pool, previousAppPool]);
        if (root) rmSync(root, { recursive: true, force: true });
      }
    }
  }
}
