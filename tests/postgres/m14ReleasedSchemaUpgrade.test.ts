import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresDeliveryAlignmentPort } from "@openlup/platform/fulfillment";
import { createPostgresPaymentTruthPort } from "@openlup/platform/payments";
import { executor, fixture, openCase } from "../helpers/fulfillmentNative.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
const units = [manifest.baseline, ...manifest.forward];
const releasedUnits = 77;
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
  expect(await exit).toEqual({ code: null, signal: "SIGKILL" });
}

function startChild(connectionString: string, mode: "inside" | "between", marker: string) {
  const child = spawn(process.execPath, ["--import", "tsx", childPath, connectionString, mode, marker],
    { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  return { child, output: () => output };
}

it("upgrades the released 0.23 legacy prefix through real backfill, killed transactions and exact replay", async () => {
  if (!await dockerAvailable()) throw new Error("Released schema upgrade requires PostgreSQL 16");
  expect(units).toHaveLength(88);
  expect(units[releasedUnits]!.file).toBe(backfillPath);
  const prefix = { baseline: units[0], forward: units.slice(1, releasedUnits) };
  expect(sha256(JSON.stringify(prefix))).toBe(releasedPrefixSha256);
  for (const unit of units) expect(sha256(readFileSync(unit.file))).toBe(unit.sha256);

  const container = await runPostgresContainer({ name: `m14-released-upgrade-${process.pid}`,
    password: "synthetic-conformance" });
  let pool: Pool | undefined;
  let previousAppPool: Pool | undefined;
  let root: string | undefined;
  let inside: ChildProcess | undefined;
  let between: ChildProcess | undefined;
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("PostgreSQL TCP unavailable");
    pool = new Pool({ connectionString: container.connectionString });
    expect((await pool.query("SHOW server_version_num")).rows[0].server_version_num).toMatch(/^16/);
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
    const predecessor = createPostgresMigrationRunner({ connectionString: container.connectionString },
      { root, poolFactory: () => pool! });
    expect((await predecessor.apply()).applied).toHaveLength(releasedUnits);
    expect((await predecessor.status()).pending).toEqual([]);

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
    expect(accepted.event).toMatchObject({ state: "settled", replayed: false });
    await pool.query(`INSERT INTO public.fulfillment_shipment_operations
      (shipment_id,order_id,operation_type,idempotency_key,payload)
      VALUES($1,$2,'shipment_advanced',$3,'{"toStatus":"handed_over"}')`,
    [retained.shipment, retained.order, `handoff-${retained.shipment}`]);
    const sources = (await pool.query(`SELECT 'paid' AS source_kind,id AS source_id FROM public.commerce_settlement_transitions
      UNION ALL SELECT 'handoff',id FROM public.fulfillment_shipment_operations ORDER BY source_kind,source_id`)).rows;
    expect(sources.length).toBeGreaterThanOrEqual(2);
    const priorOrder = (await pool.query("SELECT * FROM public.commerce_orders WHERE id=$1", [retained.order])).rows;
    const priorSubscription = (await pool.query("SELECT * FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows;
    const ledger = async () => (await pool!.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows;
    const expectedLedger = units.map((unit, position) => ({
      catalog_path: unit.file, sha256: unit.sha256, position,
    }));
    expect(await ledger()).toEqual(expectedLedger.slice(0, releasedUnits));

    // The child enters the real backfill SQL while the source relation is held.
    // SIGKILL then aborts its open unit transaction, including CREATE TABLE.
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE public.commerce_settlement_transitions IN ACCESS EXCLUSIVE MODE");
      const running = startChild(container.connectionString, "inside", join(root, "inside-marker"));
      inside = running.child;
      await waitUntil(async () => Number((await pool!.query(`SELECT count(*) FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND query LIKE '%CREATE TABLE public.invoicing_cutover%'`)).rows[0].count) === 1,
      "backfill unit lock wait");
      await killed(inside);
      inside = undefined;
      expect(running.output()).toBe("");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await ledger()).toEqual(expectedLedger.slice(0, releasedUnits));
    expect((await pool.query("SELECT to_regclass('public.invoicing_cutover') AS table_name")).rows[0].table_name).toBeNull();

    // The first real forward commits. A test transport hook parks before the
    // next BEGIN so the second SIGKILL is unambiguously between units.
    const marker = join(root, "between-marker");
    const running = startChild(container.connectionString, "between", marker);
    between = running.child;
    await waitUntil(() => existsSync(marker), "between-unit barrier");
    expect(await ledger()).toEqual(expectedLedger.slice(0, releasedUnits + 1));
    await killed(between);
    between = undefined;
    expect(running.output()).toBe("");
    expect((await pool.query(`SELECT source_kind,source_id FROM public.invoicing_cutover
      ORDER BY source_kind,source_id`)).rows).toEqual(sources);
    expect((await pool.query("SELECT * FROM public.commerce_orders WHERE id=$1", [retained.order])).rows).toEqual(priorOrder);

    expect((await pool.query("SELECT * FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows).toEqual(priorSubscription);

    const current = createPostgresMigrationRunner({ connectionString: container.connectionString },
      { poolFactory: () => pool! });
    expect((await current.apply()).applied).toEqual(units.slice(releasedUnits + 1).map(unit => unit.file));
    expect(await ledger()).toEqual(expectedLedger);
    expect(await current.apply()).toEqual({ applied: [] });
    expect((await current.status()).pending).toEqual([]);
    expect((await pool.query(`SELECT source_kind,source_id FROM public.invoicing_cutover
      ORDER BY source_kind,source_id`)).rows).toEqual(sources);
    expect((await pool.query("SELECT * FROM public.commerce_orders WHERE id=$1", [retained.order])).rows).toEqual(priorOrder);

    // An optional pinned local package supplies actual previous application
    // code. The CI path still proves the complete database upgrade offline.
    const releasedPayments = process.env.OPENLUP_M14_RELEASED_PAYMENTS;
    if (releasedPayments) {
      const releasedPackage = JSON.parse(readFileSync(join(dirname(releasedPayments), "..", "..", "package.json"), "utf8"));
      expect(releasedPackage).toMatchObject({ name: "@openlup/platform", version: "0.23.0" });
      const previous = await import(pathToFileURL(releasedPayments).href);
      await pool.query("CREATE ROLE m14_previous_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'synthetic-conformance'");
      await pool.query(`GRANT USAGE ON SCHEMA public TO m14_previous_app;
        GRANT SELECT,INSERT,UPDATE ON public.payment_truth_events TO m14_previous_app;
        GRANT SELECT ON public.commerce_settlement_intents,public.commerce_orders,
          public.subscription_cycles,public.subscriptions,public.accounting_documents TO m14_previous_app;
        GRANT EXECUTE ON FUNCTION public.payment_truth_readback(uuid,boolean),
          public.payment_truth_ingest_event(text,text,text,uuid,text,bigint,text,timestamptz,text,text,jsonb,text,text,text)
          TO m14_previous_app`);
      const oldAppUrl = new URL(container.connectionString);
      oldAppUrl.username = "m14_previous_app";
      oldAppUrl.password = "synthetic-conformance";
      previousAppPool = new Pool({ connectionString: oldAppUrl.toString() });
      const previousPort = previous.createPostgresPaymentTruthPort(executor(previousAppPool), paymentOptions);
      expect(await previousPort.readEvent(accepted.event.id)).toMatchObject({
        event: { id: accepted.event.id, state: "settled" },
      });
      expect(await previousPort.ingestEvent(paymentInput)).toMatchObject({
        event: { id: accepted.event.id, replayed: true, state: "settled" },
      });
      expect((await pool.query("SELECT count(*)::int AS count FROM public.payment_truth_events WHERE source_event_id=$1",
        [paymentInput.sourceEventId])).rows[0].count).toBe(1);
    }

    // A late customer arrival extends one cycle; its replay cannot stack the
    // extension, and earlier evidence cannot pull a different cycle earlier.
    await openCase(pool, retained);
    const arrival = createPostgresDeliveryAlignmentPort(executor(pool));
    const event = { requestKey: `arrival-${retained.shipment}`, parcelRef: retained.shipment,
      deliveredAt: "2026-09-04T12:00:00Z", evidenceRef: `evidence:${retained.shipment}` as const };
    expect(await arrival.recordArrival(event)).toMatchObject({ disposition: "aligned",
      nextCycleAt: "2026-10-02T12:00:00.000Z" });
    const afterArrival = (await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows[0].next_cycle_at;
    expect(await arrival.recordArrival(event)).toMatchObject({ replayed: true });
    expect((await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows[0].next_cycle_at).toEqual(afterArrival);
    expect(new Date(afterArrival).toISOString()).toBe("2026-10-02T12:00:00.000Z");
    const earlier = await fixture(pool);
    await openCase(pool, earlier);
    const earlierArrival = { requestKey: `arrival-${earlier.shipment}`, parcelRef: earlier.shipment,
      deliveredAt: "2026-07-01T12:00:00Z", evidenceRef: `evidence:${earlier.shipment}` as const };
    expect(await arrival.recordArrival(earlierArrival)).toMatchObject({ disposition: "aligned",
      nextCycleAt: "2026-08-29T12:00:00.000Z" });
    expect(await arrival.recordArrival(earlierArrival)).toMatchObject({ replayed: true });
    expect((await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [earlier.subscription])).rows[0].next_cycle_at.toISOString()).toBe("2026-08-29T12:00:00.000Z");
  } finally {
    if (inside && inside.exitCode === null) inside.kill("SIGKILL");
    if (between && between.exitCode === null) between.kill("SIGKILL");
    await closePostgres(container, [pool, previousAppPool]);
    if (root) rmSync(root, { recursive: true, force: true });
  }
}, postgresSetupTimeoutMs);
