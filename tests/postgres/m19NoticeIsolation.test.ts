/** Native notice real-driver diagnostics for delivery isolation and runtime prerequisites. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createCapturedTransactionalDelivery,
  createPostgresTransactionalDeliveryStore,
  createTransactionalDelivery,
} from "@openlup/platform/communications";
import { createPostgresLifecycleMessages, type NativeLifecycleNotice } from "@openlup/platform/subscriptions";
import type { CapturedTransactionalDeliveryPort } from "@openlup/platform/communications";
import type { OutboxEventRow } from "@openlup/core/outbox";
import { capturedPaidHandler, nativeNoticeOrder, refusedNoticeSources, noticeSessionWithRecipientFault } from "./m19NoticeFixture.js";
import { fixture as shipmentFixture } from "../helpers/fulfillmentNative.js";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresOperatorAuthority } from "@openlup/platform/account-support";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { readPlatformMigrationManifest, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

const selection: QualifiedPostgresInstallation = {
  generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres",
  bootstrapLogin: "postgres", runtimeLogin: "g8_runtime", restoreLogin: "g8_restore",
};
const at = "2026-11-01T12:00:00.000Z";
let container: PostgresContainer | undefined;
let admin: Pool, migration: Pool, runtime: Pool;
let runtimeUrl: string;
const forward = "db/platform/migrations/20261101231000_native_paid_email.sql";

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Native notice isolation requires real Docker PostgreSQL");
  container = await runPostgresContainer({ name: `m19-g8-isolation-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native notice PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  await admin.query(`CREATE ROLE g8_runtime LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER
    NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g8_restore LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER
    NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, {
    installation: selection, poolFactory: () => migration,
  });
  expect((await runner.apply()).applied).toContain(forward);
  expect((await runner.status()).pending).toEqual([]);
  expect(await runner.apply()).toEqual({ applied: [] });
  const url = new URL(container.connectionString);
  url.username = selection.runtimeLogin;
  url.password = "synthetic-only";
  runtimeUrl = url.toString();
  runtime = new Pool({ connectionString: runtimeUrl });
  expect((await runtime.query(`SELECT current_user AS login,session_user AS session,
    rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows)
    .toEqual([{ login: "g8_runtime", session: "g8_runtime", rolsuper: false, rolcreatedb: false,
      rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
  await expect(runtime.query("CREATE TABLE public.g8_forbidden(id integer)")).rejects.toMatchObject({ code: "42501" });
}, postgresSetupTimeoutMs);

afterAll(async () => {
  await closePostgres(container, [admin, migration, runtime]);
}, postgresTeardownTimeoutMs);

async function fixture() {
  const client = randomUUID(), subscription = randomUUID(), cycle = randomUUID();
  // Fixture setup only. Every lifecycle and delivery call below uses the installed runtime login.
  await admin.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await admin.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at)
    VALUES($1,$2,28,'2026-11-29T12:00:00Z')`, [subscription, client]);
  await admin.query(`INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status)
    VALUES($1,$2,$3,'payment_pending')`, [cycle, subscription, at]);
  return { client, subscription, cycle, key: `g8-case:${cycle}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function open(db: Pool | PoolClient, f: Fixture) {
  return (await db.query(`SELECT public.dunning_lifecycle_open_case(
    $1,$2::uuid,$3::uuid,$4::uuid,1,'2026-11-02T12:00:00Z'::timestamptz,
    'temporary','synthetic-decline',$5::timestamptz,200::bigint,'XXX',
    'subscription-payment-failed-1','/account/recovery') AS result`,
  [f.key, f.subscription, f.cycle, f.client, at])).rows[0].result;
}

async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ["subscriptions", "subscription_cycles", "subscription_dunning_cases",
    "subscription_dunning_notifications", "commerce_orders", "commerce_settlement_intents",
    "fulfillment_inventory_reservations", "subscription_pause_windows", "subscription_events"]) {
    result[table] = (await admin.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}

it("opens and replays a native case, and isolates a failed captured transport after queueing", async () => {
  const f = await fixture();
  const created = await open(runtime, f);
  expect(created).toMatchObject({ caseStatus: "open", replayed: false, notificationId: expect.any(String) });
  const before = await snapshot();
  expect(await open(runtime, f)).toEqual({ caseId: created.caseId, caseStatus: "open", replayed: true });
  expect(await snapshot()).toEqual(before);
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  try {
    const delivery = createTransactionalDelivery({ store,
      delivery: createCapturedTransactionalDelivery({ outcome: () => ({ state: "failed" }) }),
    });
    await expect(delivery.send({ idempotencyKey: `notice:${created.notificationId}`,
      recipientReference: `client:${f.client}`, templateReference: "subscription-payment-failed-1" }))
      .rejects.toThrow("transactional_delivery_unavailable");
    expect(await store.readReceipt(`notice:${created.notificationId}`)).toMatchObject({ state: "failed", attemptCount: 1 });
    expect(await snapshot()).toEqual(before);
  } finally { await store.close(); }
});

it("rolls back notice-storage contention cleanly and retries each request once after release", async () => {
  const fresh = await fixture(), existing = await fixture();
  const created = await open(runtime, existing);
  const before = await snapshot();
  const blocker = await admin.connect(), caller = await runtime.connect();
  const failures: { phase: string; code?: string; where?: string; elapsedMs: number }[] = [];
  try {
    await blocker.query("BEGIN");
    // SHARE permits reads but conflicts with notice INSERT/UPDATE. No domain table is locked.
    await blocker.query("LOCK TABLE public.subscription_dunning_notifications IN SHARE MODE");
    for (const phase of ["open", "advance"] as const) {
      await caller.query("BEGIN");
      await caller.query("SET LOCAL lock_timeout='150ms'");
      const started = performance.now();
      try {
        if (phase === "open") await open(caller, fresh);
        else await caller.query(`SELECT public.dunning_lifecycle_handle_failure(
          $1::uuid,$2::timestamptz,'temporary','synthetic-decline',2,
          '2026-11-05T12:00:00Z'::timestamptz,'subscription-payment-failed-2','/account/recovery')`, [created.caseId, at]);
        await caller.query("COMMIT");
      } catch (error) {
        const failure = error as Error & { code?: string; where?: string };
        failures.push({ phase, code: failure.code, where: failure.where, elapsedMs: Math.round(performance.now() - started) });
      } finally { await caller.query("ROLLBACK"); }
    }
    expect(await snapshot()).toEqual(before);
    expect((await admin.query("SELECT id FROM public.subscription_dunning_cases WHERE idempotency_key=$1", [fresh.key])).rows).toEqual([]);
    expect((await admin.query("SELECT retry_attempt,status FROM public.subscription_dunning_cases WHERE id=$1", [created.caseId])).rows)
      .toEqual([{ retry_attempt: 1, status: "open" }]);
  } finally {
    await caller.query("ROLLBACK"); caller.release();
    await blocker.query("ROLLBACK"); blocker.release();
  }
  expect(failures.map(({ phase, code }) => ({ phase, code }))).toEqual([
    { phase: "open", code: "55P03" }, { phase: "advance", code: "55P03" },
  ]);
  for (const failure of failures) expect(failure.where).toContain("dunning_lifecycle_queue_notice");
  // The identical requests now succeed, with one durable notice for each rung.
  const retried = await open(runtime, fresh);
  expect(retried).toMatchObject({ caseStatus: "open", replayed: false });
  expect(await open(runtime, fresh)).toEqual({ caseId: retried.caseId, caseStatus: "open", replayed: true });
  expect((await runtime.query(`SELECT count(*)::integer AS notices FROM public.subscription_dunning_notifications
    WHERE case_id=$1`, [retried.caseId])).rows).toEqual([{ notices: 1 }]);
  const advance = () => runtime.query(`SELECT public.dunning_lifecycle_handle_failure(
    $1::uuid,$2::timestamptz,'temporary','synthetic-decline',2,
    '2026-11-05T12:00:00Z'::timestamptz,'subscription-payment-failed-2','/account/recovery')`, [created.caseId, at]);
  await advance();
  await advance();
  expect((await runtime.query("SELECT retry_attempt,status FROM public.subscription_dunning_cases WHERE id=$1", [created.caseId])).rows)
    .toEqual([{ retry_attempt: 2, status: "open" }]);
  expect((await runtime.query(`SELECT retry_attempt,count(*)::integer AS notices
    FROM public.subscription_dunning_notifications WHERE case_id=$1 GROUP BY retry_attempt ORDER BY retry_attempt`, [created.caseId])).rows)
    .toEqual([{ retry_attempt: 1, notices: 1 }, { retry_attempt: 2, notices: 1 }]);
});

it("checks the complete existing-routine dispatch path after all eight approved grants", async () => {
  const failures: { operation: string; code: string; message: string }[] = [];
  const completed: string[] = [];
  const blocked: string[] = [];
  async function step<T>(operation: string, work: () => Promise<T>): Promise<T | undefined> {
    try { const result = await work(); completed.push(operation); return result; }
    catch (error) {
      const failure = error as Error & { code?: string };
      failures.push({ operation, code: failure.code ?? "application_assertion", message: failure.message });
    }
  }
  const f = await fixture(), created = await open(runtime, f);
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  try {
    await step("existing underlying relation privileges", async () => {
      for (const table of ["clients", "subscriptions", "subscription_dunning_notifications",
        "subscription_events", "subscription_reminder_ledger", "communication_delivery_controls",
        "communication_recipient_consents", "transactional_delivery_receipts"]) {
        expect((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS allowed", [`public.${table}`])).rows[0].allowed).toBe(true);
      }
      for (const table of ["subscription_dunning_notifications", "transactional_delivery_receipts"]) {
        expect((await runtime.query("SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE') AS allowed", [`public.${table}`])).rows[0].allowed).toBe(true);
      }
      expect((await runtime.query("SELECT has_table_privilege(current_user,'public.subscription_reminder_ledger','INSERT') AS allowed")).rows[0].allowed).toBe(true);
    });
    const captured = createCapturedTransactionalDelivery();
    let captures = 0;
    const delivery = createTransactionalDelivery({ store, delivery: { async deliver(command) {
      captures += 1; return captured.deliver(command);
    } } });
    const rows = await step("subscription_dunning_claim_batch(integer,integer,integer)", async () =>
      (await runtime.query("SELECT * FROM public.subscription_dunning_claim_batch(100,30,3)")).rows);
    const notice = rows?.find(row => row.id === created.notificationId);
    expect(notice).toBeDefined();
    await step("captured delivery, receipts and sequential replay", async () => {
      const command = { idempotencyKey: `notice:${notice!.id}`, recipientReference: `client:${f.client}`,
        templateReference: String(notice!.template_slug) };
      const receipt = await delivery.send(command);
      expect(await store.readReceipt(command.idempotencyKey)).toEqual(receipt);
      expect(await delivery.send(command)).toEqual(receipt);
      expect(captures).toBe(1);
      const marked = await runtime.query("SELECT public.subscription_dunning_mark_sent($1::uuid,$2::uuid,$3) AS result",
        [notice!.id, notice!.claim_token, receipt.deliveryReference]);
      expect(marked.rows[0].result).toBe(true);
    });
    await step("subscription_dunning_mark_sent(uuid,uuid,text): stale token", async () => {
      expect((await runtime.query("SELECT public.subscription_dunning_mark_sent($1::uuid,$2::uuid,'captured:stale') AS result",
        [notice!.id, randomUUID()])).rows[0].result).toBe(false);
    });
    const failed = await open(runtime, await fixture());
    const claimed = await step("claim second notice", async () =>
      (await runtime.query("SELECT * FROM public.subscription_dunning_claim_batch(100,30,3)")).rows.find(row => row.id === failed.notificationId));
    const beforeFailure = await snapshot();
    await step("failed captured delivery and failed receipt", async () => {
      const unavailable = createTransactionalDelivery({ store,
        delivery: createCapturedTransactionalDelivery({ outcome: () => ({ state: "failed" }) }) });
      await expect(unavailable.send({ idempotencyKey: `notice:${failed.notificationId}`,
        recipientReference: `client:${claimed!.recipient_ref}`, templateReference: String(claimed!.template_slug) }))
        .rejects.toThrow("transactional_delivery_unavailable");
      expect(await store.readReceipt(`notice:${failed.notificationId}`)).toMatchObject({ state: "failed" });
      expect(await snapshot()).toEqual(beforeFailure);
    });
    await step("subscription_dunning_mark_result(uuid,uuid,text,text,timestamptz)", async () => {
      expect((await runtime.query(`SELECT public.subscription_dunning_mark_result(
        $1::uuid,$2::uuid,'failed','captured_delivery_failed',NULL) AS result`, [failed.notificationId, claimed!.claim_token])).rows[0].result).toBe(true);
      expect((await runtime.query(`SELECT public.subscription_dunning_mark_result(
        $1::uuid,$2::uuid,'queued','stale',NULL) AS result`, [failed.notificationId, randomUUID()])).rows[0].result).toBe(false);
    });
    await step("dunning_lifecycle_recipient(uuid)", async () => {
      expect((await runtime.query("SELECT public.dunning_lifecycle_recipient($1::uuid) AS result", [f.client])).rows[0].result.email)
        .toBe(`${f.client}@example.invalid`);
    });
    await step("communications_notification_control_enabled(text[])", async () => {
      expect((await runtime.query("SELECT public.communications_notification_control_enabled($1::text[]) AS result",
        [["subscription-dunning", "subscription-lifecycle"]])).rows[0].result).toBe(true);
    });
    await step("communications_recipient_consent_state(text,text[])", async () => {
      expect((await runtime.query("SELECT public.communications_recipient_consent_state($1,$2::text[]) AS result",
        ["a".repeat(64), ["subscription_dunning"]])).rows[0].result).toBe("unknown");
    });
    await step("dunning_lifecycle_renewal_reminder_enqueue(integer)", () =>
      runtime.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)"));
    await step("dunning_lifecycle_pause_reminder_dispatch(integer)", async () => {
      const paused = await fixture();
      // Explicit synthetic customer pause supplies a real future pause window.
      await runtime.query(`SELECT public.subscription_apply_lifecycle_action($1::uuid,$2,$3::uuid,
        'pause',$4::jsonb,$5::timestamptz)`, [paused.client, `pause:${paused.subscription}`, paused.subscription,
        { pausePreset: "2_weeks" }, new Date().toISOString()]);
      return runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100)");
    });
    await step("subscription_apply_lifecycle_action and event read/dispatch", async () => {
      const lifecycle = await fixture();
      await runtime.query(`SELECT public.subscription_apply_lifecycle_action($1::uuid,$2,$3::uuid,
        'slide_next_cycle',$4::jsonb,$5::timestamptz)`, [lifecycle.client, `slide:${lifecycle.subscription}`, lifecycle.subscription,
        { newNextCycleAt: "2026-11-30T12:00:00Z" }, at]);
      const event = (await runtime.query("SELECT id,event_type FROM public.subscription_events WHERE subscription_id=$1", [lifecycle.subscription])).rows[0];
      expect(event.event_type).toBe("subscription.customer_self_service.slide_next_cycle");
      const command = { idempotencyKey: `event:${event.id}`, recipientReference: `client:${lifecycle.client}`,
        templateReference: "subscription-delivery-rescheduled" };
      expect(await delivery.send(command)).toEqual(await delivery.send(command));
    });
    const reminders = await step("reminder ledger read", async () => {
      // Do not seed a reminder or manufacture one after an enqueue refusal.
      return (await runtime.query(`SELECT r.id,r.reminder_kind,s.client_id
        FROM public.subscription_reminder_ledger r JOIN public.subscriptions s ON s.id=r.subscription_id`)).rows;
    });
    if (!reminders?.length) blocked.push("reminder delivery: no native source because both producers refused");
    else await step("reminder captured delivery and replay", async () => {
      for (const reminder of reminders) {
        const command = { idempotencyKey: `reminder:${reminder.id}`, recipientReference: `client:${reminder.client_id}`,
          templateReference: reminder.reminder_kind === "pause_ending" ? "subscription-pause-reminder" : "subscription-renewal-upcoming" };
        expect(await delivery.send(command)).toEqual(await delivery.send(command));
      }
    });
  } finally { await store.close(); }
  console.info("Native notice full routine dispatch inventory", JSON.stringify({ completed, blocked, failures }));
  expect(failures).toEqual([]);
  expect(blocked).toEqual([]);
});

it("retains native notice sources and accepted receipts through connected capture and restore", async () => {
  const target = await runPostgresContainer({ name: `m19-g8-transfer-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [];
  try {
    expect(await waitForPostgresTcpReady(target.connectionString)).toBe(true);
    const bootstrap = new Pool({ connectionString: target.connectionString }); pools.push(bootstrap);
    await bootstrap.query(`CREATE ROLE g8_runtime LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE g8_restore LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const owner = new Pool({ connectionString: target.connectionString, options: qualifiedPostgresStartupOptions(selection) }); pools.push(owner);
    const runner = createPostgresMigrationRunner({ connectionString: target.connectionString }, {
      installation: selection, poolFactory: () => owner,
    });
    await runner.apply();
    const manifest = selectPlatformMigrationManifest(readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest, "qualified-v2", { migrationIsBootstrap: true, hasRestore: true });
    const capture = (db: Pool, sourceId: string) => captureConnectedNativeStore({ sourceId,
      catalogueId: manifest.objectInventorySha256, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
      source: { async withSnapshot(work) {
        const client = await db.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
          await client.query("COMMIT"); return result;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      } },
    });
    const packet = await capture(admin, "native-notices"), freshTarget = await capture(owner, "new-target");
    const tables = ["subscription_dunning_cases", "subscription_dunning_notifications", "subscription_reminder_ledger", "transactional_delivery_receipts"];
    for (const table of tables) expect(packet.owned.find(rows => rows.table === table)!.rows.length).toBeGreaterThan(0);
    const input = { owner, installation: selection, packet, freshTarget };
    expect((await restoreConnectedNativeStore(input)).replayed).toBe(false);
    const restored = await capture(owner, "restored-notices");
    for (const table of tables) expect(restored.owned.find(rows => rows.table === table)).toEqual(packet.owned.find(rows => rows.table === table));
    expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
  } finally { await closePostgres(target, pools); }
}, postgresSetupTimeoutMs);

it("takes the native settlement trigger payload through the paid handler and transactional delivery captured dispatch once", async () => {
  const f = await nativeNoticeOrder(admin, runtime);
  await f.settle(); await f.settle();
  const events = (await runtime.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1::uuid AND event_type IN ('commerce.order.paid','commerce.order.paid.email') ORDER BY event_type", [f.order])).rows;
  expect(events.map(row => row.event_type)).toEqual(["commerce.order.paid", "commerce.order.paid.email"]);
  expect(events[0].payload).toEqual({ orderUuid: f.order, occurredAt: expect.any(String) });
  expect(events[1].payload).toEqual({ orderUuid: f.order, orderId: `order_${f.order}`, mode: "one_time", occurredAt: expect.any(String) });
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  let captures = 0;
  const observed: { orderId: string; to: string; total: string | null }[] = [];
  try {
    const captured = createCapturedTransactionalDelivery();
    const delivery = createTransactionalDelivery({ store, delivery: { async deliver(command) { captures++; return captured.deliver(command); } } });
    const handler = capturedPaidHandler(runtime, store, delivery, observed);
    const registry = new Map([[handler.eventType, handler]]);
    const row = events[1] as OutboxEventRow;
    const before = await snapshot();
    expect(await registry.get(row.event_type)!.handle(row, new AbortController().signal)).toMatchObject({ kind: "processed" });
    expect(await handler.handle(row, new AbortController().signal)).toMatchObject({ kind: "processed", detail: { dedupe: "email_already_sent" } });
    expect(captures).toBe(1);
    expect(observed).toEqual([{ orderId: `order_${f.order}`, to: expect.stringContaining("@example.invalid"), total: "200 XXX" }]);
    expect(await snapshot()).toEqual(before);
    const failed = await nativeNoticeOrder(admin, runtime);
    await failed.settle();
    const failureRow = (await runtime.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1::uuid AND event_type='commerce.order.paid.email'", [failed.order])).rows[0] as OutboxEventRow;
    const beforeFailure = await snapshot();
    const failing = capturedPaidHandler(runtime, store, createTransactionalDelivery({ store,
      delivery: createCapturedTransactionalDelivery({ outcome: () => ({ state: "failed" }) }) }), []);
    await expect(failing.handle(failureRow, new AbortController().signal)).rejects.toThrow("transactional_delivery_unavailable");
    expect(await snapshot()).toEqual(beforeFailure);
  } finally { await store.close(); }
});

it("absorbs mail-only SQL errors and cancellation, and finds lost capture with the owner query", async () => {
  const lost: string[] = [];
  await admin.query(`CREATE FUNCTION public.g8_mail_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'synthetic mail failure' USING ERRCODE='57014'; END $$;
    CREATE TRIGGER g8_mail_fault BEFORE INSERT ON public.outbox_events FOR EACH ROW
    WHEN (NEW.event_type='commerce.order.paid.email') EXECUTE FUNCTION public.g8_mail_fault()`);
  try {
    for (const code of ["57014", "P0001"]) {
      await admin.query(`CREATE OR REPLACE FUNCTION public.g8_mail_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'synthetic mail failure' USING ERRCODE='${code}'; END $$`);
      const f = await nativeNoticeOrder(admin, runtime);
      await f.settle(); await f.settle(); lost.push(f.order);
      expect((await runtime.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.order])).rows[0].status).toBe("paid");
      expect((await runtime.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1", [f.intent])).rows[0].status).toBe("settled");
      expect((await runtime.query("SELECT event_type FROM public.outbox_events WHERE aggregate_id=$1 AND event_type LIKE 'commerce.order.paid%'", [f.order])).rows)
        .toEqual([{ event_type: "commerce.order.paid" }]);
    }
  } finally { await admin.query("DROP TRIGGER g8_mail_fault ON public.outbox_events; DROP FUNCTION public.g8_mail_fault()"); }
  const complete = await nativeNoticeOrder(admin, runtime), unpaid = await nativeNoticeOrder(admin, runtime);
  await complete.settle();
  const ownerDoc = readFileSync("docs/platform/DATA_AND_MIGRATIONS.md", "utf8");
  const query = ownerDoc.split("### Paid-mail capture repair\n")[1]!.match(/```sql\n([\s\S]*?)\n```/)![1]!;
  const caller = await runtime.connect();
  try {
    await caller.query("BEGIN READ ONLY");
    const found = (await caller.query(query)).rows.map(row => row.order_uuid);
    expect(found).toEqual(expect.arrayContaining(lost));
    expect(found).not.toContain(complete.order);
    expect(found).not.toContain(unpaid.order);
  } finally { await caller.query("ROLLBACK"); caller.release(); }
});

it("bounds mail-only lock waits and restores the settlement caller's timeout", async () => {
  const blocker = await admin.connect(), caller = await runtime.connect();
  await admin.query(`CREATE FUNCTION public.g8_mail_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_advisory_xact_lock(19908001); RETURN NEW; END $$;
    CREATE TRIGGER g8_mail_lock BEFORE INSERT ON public.outbox_events FOR EACH ROW
    WHEN (NEW.event_type='commerce.order.paid.email') EXECUTE FUNCTION public.g8_mail_lock()`);
  try {
    await blocker.query("SELECT pg_advisory_lock(19908001)");
    const f = await nativeNoticeOrder(admin, runtime);
    await caller.query("SET lock_timeout='2s'");
    const started = performance.now();
    await f.settle(caller);
    expect(performance.now() - started).toBeLessThan(5000);
    expect((await caller.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("2s");
    expect((await runtime.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.order])).rows[0].status).toBe("paid");
    expect((await runtime.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.paid.email'", [f.order])).rows).toEqual([]);
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(19908001)"); blocker.release();
    await caller.query("SET lock_timeout='0'"); caller.release();
    await admin.query("DROP TRIGGER g8_mail_lock ON public.outbox_events; DROP FUNCTION public.g8_mail_lock()");
  }
});

function noticeBinding(store: ReturnType<typeof createPostgresTransactionalDeliveryStore>, captured: CapturedTransactionalDeliveryPort, observed: NativeLifecycleNotice[], unresolvedClients: ReadonlySet<string> = new Set()) {
  const delivery = createTransactionalDelivery({ store, delivery: captured });
  return createPostgresLifecycleMessages({ delivery: { send: delivery.send, readReceipt: store.readReceipt },
    async withSession(work) { const db = await runtime.connect(); try { return await work(noticeSessionWithRecipientFault(db, unresolvedClients)); } finally { db.release(); } },
    async bind(notice, recipient) {
      expect(recipient.email).toContain("@example.invalid"); observed.push(notice);
      return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug };
    },
  });
}

it("dispatches real activation, lifecycle, renewal and pause-reminder sources through the public binding without replay sends", async () => {
  const f = await nativeNoticeOrder(admin, runtime, undefined, "subscription");
  await f.settle();
  await runtime.query("SELECT public.subscription_declare_provisional_activation($1,$2::uuid,28)", [`declare:${f.order}`, f.order]);
  const external = (await runtime.query("SELECT external_ref FROM public.commerce_settlement_intents WHERE id=$1", [f.intent])).rows[0].external_ref;
  const activated = (await runtime.query("SELECT public.subscription_activate_from_captured_payment($1,$2::uuid,$3) AS result",
    [`activate:${f.order}`, f.order, createHash("sha256").update(String(external ?? f.intent)).digest("hex")])).rows[0].result;
  const paused = await fixture();
  await runtime.query(`SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'pause',$4::jsonb,$5::timestamptz)`,
    [paused.client, `pause:${paused.subscription}`, paused.subscription, { pausePreset: "2_weeks" }, new Date().toISOString()]);
  const repair = await fixture(); await open(runtime, repair);
  const observed: NativeLifecycleNotice[] = [], captures: string[] = [];
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const captured = createCapturedTransactionalDelivery({ outcome: command => { captures.push(command.idempotencyKey); return { state: "accepted" }; } });
  try {
    const binding = noticeBinding(store, captured, observed);
    expect((await binding.run(100)).failed).toBe(0);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId: activated.subscriptionId, templateSlug: "subscription-welcome" }),
      expect.objectContaining({ subscriptionId: activated.subscriptionId, templateSlug: "subscription-renewal-upcoming" }),
      expect.objectContaining({ subscriptionId: paused.subscription, templateSlug: "subscription-paused" }),
      expect.objectContaining({ subscriptionId: paused.subscription, templateSlug: "subscription-pause-reminder" }),
      expect.objectContaining({ subscriptionId: repair.subscription, templateSlug: "subscription-payment-failed-1" }),
    ]));
    const before = [...captures];
    await binding.run(100);
    expect(captures).toEqual(before);
    await expect(binding.run(0)).rejects.toThrow("subscription_notice_limit_invalid");
  } finally { await store.close(); }
});

it("sends one future-only address-change notice to the existing customer, never the destination, and none on replay", async () => {
  const f = await fixture(), actor = randomUUID(), event = randomUUID(), destination = randomUUID();
  const destinationEmail = `${destination}@example.invalid`;
  // Labelled destination-writer event fixture: 20261101225000_commerce_destinations.sql is not installed here.
  // Its destination UUID deliberately matches another client's ID to catch recipient lookup confusion.
  // The real destination-writer join runs after that writer lands, at integration.
  await admin.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [destination, destinationEmail]);
  const payload = { action: "change_shipping_address", payload: { shippingAddressId: destination },
    actorKind: "operator", actorId: actor, outcome: "applied_from_next_parcel", appliesFrom: "next_parcel",
    futureDestinationId: destination,
    priceAgreementPolicy: { kind: "lock_until_edit", proration: "none", cycleEffect: "future_unlocked_cycles_only" } };
  await admin.query(`INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload,occurred_at)
    VALUES($1,$2,'subscription.customer_self_service.change_shipping_address',$3,$4::jsonb,$5::timestamptz)`,
  [event, f.subscription, `command:${createHash("sha256").update(`${actor}:g8-address:${event}`).digest("hex")}`, payload, at]);
  const recipient = (await runtime.query("SELECT public.dunning_lifecycle_recipient($1::uuid) AS recipient", [f.client])).rows[0].recipient;
  expect(recipient.email).not.toBe(destinationEmail);
  const key = `subscription-notice:event:${event}`, notices: NativeLifecycleNotice[] = [];
  const captures: { idempotencyKey: string; recipientReference: string }[] = [];
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const captured = createCapturedTransactionalDelivery({ outcome: command => {
    if (command.idempotencyKey === key) captures.push({ idempotencyKey: command.idempotencyKey, recipientReference: command.recipientReference });
    return { state: "accepted" };
  } });
  const delivery = createTransactionalDelivery({ store, delivery: captured });
  try {
    const binding = createPostgresLifecycleMessages({ delivery: { send: delivery.send, readReceipt: store.readReceipt },
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      async bind(notice, contact) {
        if (notice.id === event) { expect(contact).toEqual(recipient); notices.push(notice); }
        return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug };
      },
    });
    expect((await binding.run(100)).failed).toBe(0);
    expect(notices).toEqual([expect.objectContaining({ id: event, clientId: f.client, kind: "subscription.address_changed",
      templateSlug: "subscription-address-changed", payload })]);
    expect(captures).toEqual([{ idempotencyKey: key, recipientReference: `client:${f.client}` }]);
    await binding.run(100);
    expect(notices).toHaveLength(1);
    expect(captures).toEqual([{ idempotencyKey: key, recipientReference: `client:${f.client}` }]);
  } finally { await store.close(); }
});

it("serializes competing public-binding sends using a real PostgreSQL session lease", async () => {
  const f = await fixture();
  await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'cancel')", [f.client, `cancel:${f.subscription}`, f.subscription]);
  const event = (await runtime.query("SELECT id FROM public.subscription_events WHERE subscription_id=$1", [f.subscription])).rows[0].id;
  const key = `subscription-notice:event:${event}`;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const captures: string[] = [];
  const captured = createCapturedTransactionalDelivery({ outcome: async command => {
    captures.push(command.idempotencyKey); if (command.idempotencyKey === key) { entered(); await held; }
    return { state: "accepted" };
  } });
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const binding = noticeBinding(store, captured, []);
  const first = binding.run(100);
  try {
    await started;
    expect((await binding.run(100)).busy).toBeGreaterThan(0);
  } finally { release(); }
  try {
    await first; await binding.run(100);
    expect(captures.filter(value => value === key)).toHaveLength(1);
  } finally { await store.close(); }
});

it("gives competing public-binding workers one native dunning claim and one capture", async () => {
  const f = await fixture(), created = await open(runtime, f);
  const key = `subscription-notice:dunning:${created.notificationId}`;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const captures: string[] = [];
  const captured = createCapturedTransactionalDelivery({ outcome: async command => {
    captures.push(command.idempotencyKey); if (command.idempotencyKey === key) { entered(); await held; }
    return { state: "accepted" };
  } });
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const binding = noticeBinding(store, captured, []);
  const first = binding.run(100);
  try {
    await started; await binding.run(100);
    expect(captures.filter(value => value === key)).toHaveLength(1);
    expect((await runtime.query("SELECT attempt_count,status FROM public.subscription_dunning_notifications WHERE id=$1", [created.notificationId])).rows[0])
      .toEqual({ attempt_count: 1, status: "sending" });
  } finally { release(); }
  try {
    await first; await binding.run(100);
    expect(captures.filter(value => value === key)).toHaveLength(1);
  } finally { await store.close(); }
});

it("recovers a lost notice acknowledgement without resending, and rejects the actual stale claim", async () => {
  const f = await fixture(), created = await open(runtime, f);
  const first = (await runtime.query("SELECT * FROM public.subscription_dunning_claim_batch(100,1,6)")).rows.find(row => row.id === created.notificationId)!;
  const key = `subscription-notice:dunning:${created.notificationId}`;
  let captures = 0;
  const captured = createCapturedTransactionalDelivery({ outcome: () => { captures++; return { state: "accepted" }; } });
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  try {
    await createTransactionalDelivery({ store, delivery: captured }).send({ idempotencyKey: key, recipientReference: `client:${f.client}`, templateReference: "subscription-payment-failed-1" });
    await new Promise(resolve => setTimeout(resolve, 1100));
    const next = (await runtime.query("SELECT * FROM public.subscription_dunning_claim_batch(100,60,6)")).rows.find(row => row.id === first.id)!;
    expect(next.claim_token).not.toBe(first.claim_token);
    expect((await runtime.query("SELECT public.subscription_dunning_mark_sent($1,$2,'captured:stale') AS ok", [first.id, first.claim_token])).rows[0].ok).toBe(false);
    expect((await runtime.query("SELECT public.subscription_dunning_mark_result($1,$2,'failed','stale',NULL) AS ok", [first.id, first.claim_token])).rows[0].ok).toBe(false);
    await runtime.query("SELECT public.subscription_dunning_mark_result($1,$2,'queued',NULL,NULL)", [next.id, next.claim_token]);
    const unrelatedCaptures: string[] = [];
    const resumed = createCapturedTransactionalDelivery({ outcome: command => { unrelatedCaptures.push(command.idempotencyKey); return { state: "accepted" }; } });
    expect((await noticeBinding(store, resumed, []).run(100)).replayed).toBeGreaterThan(0);
    expect(captures).toBe(1); expect(unrelatedCaptures).not.toContain(key);
    expect((await runtime.query("SELECT status FROM public.subscription_dunning_notifications WHERE id=$1", [first.id])).rows[0].status).toBe("sent");
  } finally { await store.close(); }
});

it("keeps payment, the repair case and active service unchanged after failed public-binding delivery and exhaustion", async () => {
  const f = await fixture(), payment = await nativeNoticeOrder(admin, runtime, f.client);
  const created = await open(runtime, f);
  await runtime.query(`SELECT public.dunning_lifecycle_handle_failure($1,$2,'hard_do_not_retry','synthetic',4,NULL,
    'subscription-payment-expired','/account/recovery')`, [created.caseId, new Date().toISOString()]);
  const core = async () => ({
    subscription: (await runtime.query("SELECT * FROM public.subscriptions WHERE id=$1", [f.subscription])).rows,
    repair: (await runtime.query("SELECT * FROM public.subscription_dunning_cases WHERE id=$1", [created.caseId])).rows,
    intent: (await runtime.query("SELECT * FROM public.commerce_settlement_intents WHERE id=$1", [payment.intent])).rows,
    order: (await runtime.query("SELECT * FROM public.commerce_orders WHERE id=$1", [payment.order])).rows,
  });
  const before = await core();
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  try {
    const binding = noticeBinding(store, createCapturedTransactionalDelivery({ outcome: () => ({ state: "failed" }) }), []);
    expect((await binding.run(100)).failed).toBeGreaterThan(0);
    expect(await core()).toEqual(before);
    expect(before.subscription[0].status).toBe("active");
    expect(before.repair[0]).toMatchObject({ status: "open", next_retry_at: null, retry_attempt: 4 });
    expect((await runtime.query("SELECT id FROM public.subscription_pause_windows WHERE subscription_id=$1", [f.subscription])).rows).toEqual([]);
  } finally { await store.close(); }
});

it("honors native control and recipient-consent refusals without capture", async () => {
  const controlled = await fixture(), first = await open(runtime, controlled);
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const captures: string[] = [];
  const captured = createCapturedTransactionalDelivery({ outcome: command => { captures.push(command.idempotencyKey); return { state: "accepted" }; } });
  try {
    await admin.query("INSERT INTO public.communication_delivery_controls(control_key,enabled) VALUES('subscription-payment-failed-1',false)");
    try { await noticeBinding(store, captured, []).run(100); }
    finally { await admin.query("DELETE FROM public.communication_delivery_controls WHERE control_key='subscription-payment-failed-1'"); }
    expect(captures).not.toContain(`subscription-notice:dunning:${first.notificationId}`);
    expect((await runtime.query("SELECT status FROM public.subscription_dunning_notifications WHERE id=$1", [first.notificationId])).rows[0].status).toBe("skipped");
    const suppressed = await fixture(), second = await open(runtime, suppressed);
    await admin.query("SELECT public.communications_record_recipient_consent($1,'subscription_dunning','suppressed',now())",
      [createHash("sha256").update(`${suppressed.client}@example.invalid`).digest("hex")]);
    await noticeBinding(store, captured, []).run(100);
    expect(captures).not.toContain(`subscription-notice:dunning:${second.notificationId}`);
    expect((await runtime.query("SELECT status FROM public.subscription_dunning_notifications WHERE id=$1", [second.notificationId])).rows[0].status).toBe("skipped");
  } finally { await store.close(); }
});

it("refuses every newly granted routine under actual browser roles", async () => {
  const calls = [
    "SELECT * FROM public.subscription_dunning_claim_batch(1,30,6)",
    "SELECT public.subscription_dunning_mark_sent(NULL::uuid,NULL::uuid,'captured:test')",
    "SELECT public.subscription_dunning_mark_result(NULL::uuid,NULL::uuid,'failed','test',NULL)",
    "SELECT public.dunning_lifecycle_recipient(NULL::uuid)",
    "SELECT public.communications_notification_control_enabled(ARRAY['subscription']::text[])",
    "SELECT public.communications_recipient_consent_state('fingerprint',ARRAY['transactional']::text[])",
    "SELECT public.dunning_lifecycle_renewal_reminder_enqueue(1)",
    "SELECT public.dunning_lifecycle_pause_reminder_dispatch(1)",
  ];
  const caller = await runtime.connect();
  try {
    for (const role of ["anon", "authenticated"]) for (const sql of calls) {
      await caller.query("BEGIN");
      try {
        await caller.query(`SET LOCAL ROLE ${role}`);
        await expect(caller.query(sql)).rejects.toMatchObject({ code: "42501" });
      } finally { await caller.query("ROLLBACK"); }
    }
  } finally { caller.release(); }
});


it("joins the real future-only destination writer to one customer notice and preserves replay", async () => {
  const f = await shipmentFixture(admin), operator = randomUUID(), principal = randomUUID();
  await admin.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2),($3,$4)", [operator, `${operator}@example.invalid`, principal, `${principal}@example.invalid`]);
  await admin.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client, principal]);
  await admin.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)", [operator, at]);
  await admin.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
  const address = { recipientName: "Original recipient", line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "zz" };
  const destinations = createPostgresDestinationPort(runtime);
  const original = await destinations.registerOrder({ idempotencyKey: `g8-register:${f.order}`, orderId: f.order, address, now: at });
  await admin.query("UPDATE public.fulfillment_shipments SET status='handed_over',handed_over_at=$2 WHERE id=$1", [f.shipment, at]);
  const authority = createPostgresOperatorAuthority({ run: work => work(runtime) }, { operatorId: operator, now: () => Date.parse(at), recoveryPath: () => "/repair" });
  const input = { operatorId: operator, subscriptionId: f.subscription, subscriptionAction: "change_shipping_address" as const,
    payload: { newAddress: { ...address, recipientName: "Future recipient" } }, expectedVersion: 1, idempotencyKey: `g8-destination:${randomUUID()}` };
  expect(await authority.applySubscriptionAction(input)).toMatchObject({ outcome: "applied_from_next_parcel", appliesFrom: "next_parcel", replayed: false });
  const event = (await runtime.query("SELECT id,payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.change_shipping_address'", [f.subscription])).rows[0];
  expect(event.payload).toMatchObject({ outcome: "applied_from_next_parcel", appliesFrom: "next_parcel" });
  expect(await destinations.read("shipment", f.shipment)).toEqual(original);
  const key = `subscription-notice:event:${event.id}`, notices: NativeLifecycleNotice[] = [], captures: string[] = [];
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const captured = createCapturedTransactionalDelivery({ outcome: command => {
    if (command.idempotencyKey === key) captures.push(command.recipientReference);
    return { state: "accepted" };
  } });
  try {
    const binding = noticeBinding(store, captured, notices);
    expect((await binding.run(100)).failed).toBe(0);
    expect(notices.filter(notice => notice.id === event.id)).toEqual([expect.objectContaining({ clientId: f.client, kind: "subscription.address_changed", payload: event.payload })]);
    expect(captures).toEqual([`client:${f.client}`]);
    expect(await authority.applySubscriptionAction(input)).toMatchObject({ outcome: "applied_from_next_parcel", replayed: true });
    await binding.run(100);
    expect(captures).toEqual([`client:${f.client}`]);
    expect(await destinations.read("shipment", f.shipment)).toEqual(original);
  } finally { await store.close(); }
});


// Solo without coverage: largest new bounded witness 0.23 s; retain a 30 s per-case bound.
it.each((["event", "reminder"] as const).flatMap(source =>
  (["missing_recipient", "disabled_control", "consent_refused"] as const).flatMap(refusal =>
    ([1, 25] as const).map(limit => ({ source, refusal, limit })))))(
  "terminally refuses $source/$refusal before eligible work with batch $limit", async ({ source, refusal, limit }) => {
    const seeded = await refusedNoticeSources(admin, source, refusal, limit);
    const capturedKeys: string[] = [], observed: NativeLifecycleNotice[] = [];
    const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
    const captured = createCapturedTransactionalDelivery({ outcome: command => {
      capturedKeys.push(command.idempotencyKey); return { state: "accepted" };
    } });
    let storeClosed = false;
    const keys = seeded.refused.map(id => `subscription-notice:${source}:${id}`);
    const terminal = async () => (await runtime.query(`SELECT source,source_id,reason,
      to_char(refused_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,xmin::text,ctid::text
      FROM public.subscription_notice_refusals WHERE source=$1 AND source_id=ANY($2::uuid[]) ORDER BY source_id`, [source, seeded.refused])).rows;
    try {
      const binding = noticeBinding(store, captured, observed, seeded.unresolvedClients);
      for (let run = 0; run <= limit; run++) await binding.run(limit);
      expect(capturedKeys.filter(key => key === `subscription-notice:${source}:${seeded.eligible}`)).toHaveLength(1);
      expect(capturedKeys.some(key => keys.includes(key))).toBe(false);
      const before = await terminal();
      expect(before).toHaveLength(limit);
      expect(before.every(row => row.reason === "notice_policy_refused")).toBe(true);
      expect((await runtime.query("SELECT idempotency_key FROM public.transactional_delivery_receipts WHERE idempotency_key=ANY($1::text[])", [keys])).rows).toEqual([]);
      await seeded.changeCondition();
      // A fresh binding/session and store prove restart without an in-memory refusal cache.
      await store.close(); storeClosed = true;
      const restarted = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
      try {
        await noticeBinding(restarted, captured, observed).run(100);
        await noticeBinding(restarted, captured, observed).run(100);
      } finally { await restarted.close(); }
      expect(await terminal()).toEqual(before);
      expect(capturedKeys.some(key => keys.includes(key))).toBe(false);
      expect(observed.some(notice => seeded.refused.includes(notice.id))).toBe(false);
    } finally { await seeded.changeCondition(); if (!storeClosed) await store.close(); }
  }, 30_000,
);

it.each([1, 25])("advances through a mixed event/reminder refusal queue with batch %i", async limit => {
  const seeded: Awaited<ReturnType<typeof refusedNoticeSources>>[] = [];
  const observed: NativeLifecycleNotice[] = [], capturedKeys: string[] = [];
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const captured = createCapturedTransactionalDelivery({ outcome: command => { capturedKeys.push(command.idempotencyKey); return { state: "accepted" }; } });
  try {
    for (const source of ["event", "reminder"] as const) for (const refusal of ["missing_recipient", "disabled_control", "consent_refused"] as const) {
      seeded.push(await refusedNoticeSources(admin, source, refusal, limit === 1 ? 1 : seeded.length === 0 ? 5 : 4));
    }
    const unresolved = new Set(seeded.flatMap(row => [...row.unresolvedClients]));
    const ids = seeded.flatMap(row => row.refused);
    const terminal = async () => (await runtime.query(`SELECT source,source_id,reason,refused_at::text,xmin::text,ctid::text
      FROM public.subscription_notice_refusals WHERE source_id=ANY($1::uuid[]) ORDER BY source,source_id`, [ids])).rows;
    const binding = noticeBinding(store, captured, observed, unresolved);
    for (let run = 0; run <= ids.length + seeded.length; run++) await binding.run(limit);
    const last = seeded[seeded.length - 1]!;
    expect(ids.every(id => id < last.eligible)).toBe(true);
    expect(capturedKeys.filter(key => key === `subscription-notice:${last.source}:${last.eligible}`)).toHaveLength(1);
    const before = await terminal(); expect(before).toHaveLength(limit === 1 ? 6 : 25);
    for (const row of seeded) await row.changeCondition();
    await noticeBinding(store, captured, observed).run(100);
    await noticeBinding(store, captured, observed).run(100);
    expect(await terminal()).toEqual(before);
    for (const row of seeded) for (const id of row.refused) expect(capturedKeys).not.toContain(`subscription-notice:${row.source}:${id}`);
  } finally { for (const row of seeded) await row.changeCondition(); await store.close(); }
}, 30_000);


it("snapshots the terminal refusal table's exact columns, RLS and runtime-only append/read ACL", async () => {
  expect((await admin.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_attribute a WHERE a.attrelid='public.subscription_notice_refusals'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows)
    .toEqual([{ attname: "source", type: "text" }, { attname: "source_id", type: "uuid" },
      { attname: "reason", type: "text" }, { attname: "refused_at", type: "timestamp with time zone" }]);
  expect((await admin.query(`SELECT relrowsecurity AS rls FROM pg_class WHERE oid='public.subscription_notice_refusals'::regclass`)).rows).toEqual([{ rls: true }]);
  expect((await admin.query(`SELECT grantee::regrole::text AS role,privilege_type,is_grantable FROM pg_class c,
    LATERAL aclexplode(c.relacl) WHERE c.oid='public.subscription_notice_refusals'::regclass AND grantee<>c.relowner ORDER BY 1,2`)).rows)
    .toEqual([{ role: "service_role", privilege_type: "INSERT", is_grantable: false }, { role: "service_role", privilege_type: "SELECT", is_grantable: false }]);
  expect((await admin.query(`SELECT roles::text[] AS roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename='subscription_notice_refusals'`)).rows)
    .toEqual([{ roles: ["service_role"], cmd: "ALL", qual: "true", with_check: "true" }]);
  expect((await runtime.query(`SELECT has_table_privilege(current_user,'public.subscription_notice_refusals','INSERT') AS insert,
    has_table_privilege(current_user,'public.subscription_notice_refusals','SELECT') AS read,
    has_table_privilege(current_user,'public.subscription_notice_refusals','UPDATE') AS update,
    has_table_privilege(current_user,'public.subscription_notice_refusals','DELETE') AS delete`)).rows)
    .toEqual([{ insert: true, read: true, update: false, delete: false }]);
  await expect(runtime.query("UPDATE public.subscription_notice_refusals SET reason='notice_policy_refused' WHERE false")).rejects.toMatchObject({ code: "42501" });
  await expect(runtime.query("DELETE FROM public.subscription_notice_refusals WHERE false")).rejects.toMatchObject({ code: "42501" });
  const db = await runtime.connect();
  try {
    for (const role of ["anon", "authenticated"]) {
      await db.query("BEGIN");
      try { await db.query(`SET LOCAL ROLE ${role}`); await expect(db.query("SELECT * FROM public.subscription_notice_refusals")).rejects.toMatchObject({ code: "42501" }); }
      finally { await db.query("ROLLBACK"); }
      await db.query("BEGIN");
      try { await db.query(`SET LOCAL ROLE ${role}`); await expect(db.query("INSERT INTO public.subscription_notice_refusals(source,source_id,reason) VALUES('event',$1,'notice_policy_refused')", [randomUUID()])).rejects.toMatchObject({ code: "42501" }); }
      finally { await db.query("ROLLBACK"); }
    }
  } finally { db.release(); }
});
