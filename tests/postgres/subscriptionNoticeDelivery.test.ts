/** Native lifecycle delivery characterization through the installed restricted runtime. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresLifecycleMessages, type NativeLifecycleMessagesOptions, type NativeLifecycleNotice } from "@openlup/platform/subscriptions";
import { createPostgresOperatorAuthority } from "@openlup/platform/account-support";
import { createPostgresTransactionalDeliveryStore, createTransactionalDelivery } from "@openlup/platform/communications";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { fixture as parcelFixture } from "../helpers/fulfillmentNative.js";
import { nativeNoticeOrder } from "./m19NoticeFixture.js";

type Delivery = NativeLifecycleMessagesOptions["delivery"];
type Command = Parameters<Delivery["send"]>[0];
type QueryHook = (sql: string, values: unknown[]) => Promise<{ sql: string; values: unknown[] }>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const installation: QualifiedPostgresInstallation = {
  generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres",
  bootstrapLogin: "postgres", runtimeLogin: "notice_runtime", restoreLogin: "notice_restore",
};
let container: PostgresContainer | undefined;
let admin: Pool, migration: Pool, runtime: Pool;
let runtimeUrl: string;

beforeAll(async () => {
  container = await runPostgresContainer({ name: `m19-v-notices-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native notice PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  await admin.query(`CREATE ROLE notice_runtime LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE notice_restore LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => migration });
  await runner.apply();
  expect((await runner.status()).pending).toEqual([]);
  const url = new URL(container.connectionString);
  url.username = installation.runtimeLogin;
  url.password = "synthetic-only";
  runtimeUrl = url.toString();
  runtime = new Pool({ connectionString: runtimeUrl });
  expect((await runtime.query("SELECT current_user AS login,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ login: "notice_runtime", rolsuper: false, rolbypassrls: false }]);
  await expect(runtime.query("CREATE TABLE public.notice_forbidden(id integer)")).rejects.toMatchObject({ code: "42501" });
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [runtime, migration, admin]); }, postgresTeardownTimeoutMs);
beforeEach(async () => {
  await admin.query("UPDATE public.subscription_dunning_notifications SET status='skipped',claim_token=NULL,lease_expires_at=NULL WHERE status IN ('queued','sending')");
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  try {
    const delivery = createTransactionalDelivery({ store, delivery: { async deliver(command) {
      return { deliveryReference: `fixture:${command.idempotencyKey}` };
    } } });
    await binding("UTC", { send: delivery.send, readReceipt: store.readReceipt }).run(100);
  } finally { await store.close(); }
});

async function failure() {
  const client = randomUUID(), subscription = randomUUID(), cycle = randomUUID();
  await admin.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,$2,'customer')", [client, `${client}@example.invalid`]);
  await admin.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,now()+interval '90 days')", [subscription, client]);
  await admin.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,now(),'payment_pending')", [cycle, subscription]);
  const row = (await runtime.query(`SELECT public.dunning_lifecycle_open_case($1,$2::uuid,$3::uuid,$4::uuid,1,
    now()+interval '1 day','temporary','synthetic',now(),200,'XXX','subscription-payment-failed-1',NULL) AS result`,
  [`case:${cycle}`, subscription.toUpperCase(), cycle.toUpperCase(), client.toUpperCase()])).rows[0].result;
  // The inherited courtesy producer selects every future cycle. Capture that separate duty before this case's dunning assertions.
  await runtime.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  try {
    const delivery = createTransactionalDelivery({ store, delivery: { async deliver(command) { return { deliveryReference: `fixture:${command.idempotencyKey}` }; } } });
    const reminders = (await runtime.query("SELECT id,subscription_id FROM public.subscription_reminder_ledger")).rows;
    for (const reminder of reminders) await delivery.send({ idempotencyKey: `subscription-notice:reminder:${reminder.id}`,
      recipientReference: `subscription:${reminder.subscription_id}`, templateReference: "subscription-renewal-upcoming" });
  } finally { await store.close(); }
  return { client, subscription, cycle, caseId: String(row.caseId), noticeId: String(row.notificationId) };
}
async function operatorCase() {
  const f = await failure(), operator = randomUUID();
  const order = await nativeNoticeOrder(admin, runtime, f.client);
  await admin.query("UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1", [order.order, f.cycle]);
  await admin.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [operator, `${operator}@example.invalid`]);
  await admin.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',now())", [operator]);
  await admin.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
  return { ...f, operator, orderId: order.order };
}
async function notice(id: string) {
  return (await runtime.query("SELECT *,scheduled_at::text AS scheduled_text FROM public.subscription_dunning_notifications WHERE id=$1::uuid", [id.toUpperCase()])).rows[0];
}
async function protectedRows() {
  const rows: Record<string, unknown> = {};
  for (const table of ["commerce_orders", "commerce_settlement_intents", "payment_truth_events", "subscriptions", "subscription_cycles",
    "subscription_dunning_cases", "subscription_delivery_alignment_cases", "fulfillment_shipments", "fulfillment_inventory_reservations"]) {
    rows[table] = (await admin.query(`SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return rows;
}
function binding(zone: string, delivery: Delivery, extra: {
  bind?: NativeLifecycleMessagesOptions["bind"]; query?: QueryHook;
  dispatch?: NativeLifecycleMessagesOptions["dispatch"]; recovered?: NativeLifecycleMessagesOptions["recovered"];
} = {}) {
  return createPostgresLifecycleMessages({
    delivery, dispatch: extra.dispatch, recovered: extra.recovered,
    bind: extra.bind ?? (async value => ({ recipientReference: `client:${value.clientId}`, templateReference: value.templateSlug })),
    async withSession(work) {
      const db = await runtime.connect();
      try {
        await db.query("SELECT set_config('TimeZone',$1,false)", [zone]);
        return await work({ async query(sql, values = []) {
          // Every new predicate/finalizer receives uppercase UUIDs through the real driver.
          const uppercase = values.map(value => typeof value === "string" && uuid.test(value) ? value.toUpperCase() : value);
          const query = extra.query ? await extra.query(sql, uppercase) : { sql, values: uppercase };
          return db.query(query.sql, query.values);
        } });
      } finally { db.release(); }
    },
  });
}
const accepted: Delivery = {
  readReceipt: async () => null,
  send: async command => ({ state: "accepted", deliveryReference: `captured:${command.idempotencyKey}` }),
};

// The longest case waits 4.1 seconds; the measured full matrix takes 18.43 seconds. Each case has a 30-second budget.
describe.each(["UTC", "Etc/GMT-9", "Etc/GMT+5"])("native notice policy in %s", zone => {
  it("delivers an owner-issued operator precondition through restricted routing, capture and receipt replay", async () => {
    const f = await operatorCase();
    const operator = f.operator;
    for (const [rung, template] of [[2, "subscription-payment-failed-2"], [3, "subscription-payment-failed-3"]]) {
      await runtime.query("SELECT public.dunning_lifecycle_queue_notice($1::uuid,'payment_failed',$2,$3::integer,NULL)", [f.caseId.toUpperCase(), template, rung]);
    }
    await admin.query("UPDATE public.subscription_dunning_notifications SET created_at='2026-01-01',status='sent' WHERE case_id=$1", [f.caseId]);
    await admin.query("UPDATE public.subscription_dunning_notifications SET created_at='2025-01-01' WHERE id=$1", [f.noticeId]);
    const source = (await runtime.query("SELECT * FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='customer' AND notification_kind='payment_failed' ORDER BY created_at DESC,id DESC LIMIT 1", [f.caseId])).rows[0];
    // Precondition only: the owner executes the real operator routine. This does not establish runtime issuance.
    const authority = createPostgresOperatorAuthority({ async run(work) {
      const db = await admin.connect();
      try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
      catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    } }, { operatorId: operator.toUpperCase(), now: () => Date.now(), recoveryPath: () => "/account/recovery" });
    const command = { operatorId: operator.toUpperCase(), subjectId: f.client.toUpperCase(), caseId: f.caseId.toUpperCase(), idempotencyKey: `operator:${randomUUID()}` };
    expect((await authority.issueRecovery(command)).outcome).toBe("issued");
    const repair = (await runtime.query("SELECT * FROM public.subscription_dunning_notifications WHERE case_id=$1 AND notification_kind='payment_recovery'", [f.caseId])).rows[0];
    expect(repair.template_slug).toBe("payment_recovery");
    expect(source.retry_attempt).not.toBe(repair.retry_attempt);
    const seen: NativeLifecycleNotice[] = [];
    const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
    const captureRoot = `.context/scratch/v/operator-captured/${randomUUID()}`;
    await mkdir(captureRoot, { recursive: true, mode: 0o700 });
    const capturePath = `${captureRoot}/message.json`;
    let captures = 0;
    const delivery = createTransactionalDelivery({ store, delivery: { async deliver(value) {
      const body = JSON.stringify({ template: value.templateReference, subject: "Payment needs attention", body: "Service continues." });
      await writeFile(capturePath, body, { flag: "wx", mode: 0o600 }); captures++;
      expect(JSON.parse(await readFile(capturePath, "utf8"))).toMatchObject({ template: source.template_slug });
      return { deliveryReference: `captured:${value.idempotencyKey}` };
    } } });
    const run = binding(zone, { send: delivery.send, readReceipt: store.readReceipt }, { async bind(value) {
      seen.push({ ...value, recoveryUrlPath: value.recoveryUrlPath ? createHash("sha256").update(value.recoveryUrlPath).digest("hex") : null });
      return { recipientReference: `client:${value.clientId}`, templateReference: value.templateSlug };
    } });
    const before = await protectedRows();
    try {
      expect((await run.run()).sent).toBe(1);
      expect(seen).toEqual([expect.objectContaining({ id: repair.id, kind: "payment_recovery", clientId: f.client,
        messageKey: `subscription-notice:dunning:${repair.id}`, templateSlug: source.template_slug, payload: source.payload,
        recoveryUrlPath: createHash("sha256").update(String(repair.recovery_url_path)).digest("hex") })]);
      expect((await notice(repair.id)).status).toBe("sent");
      expect(await store.readReceipt(`subscription-notice:dunning:${repair.id}`)).toMatchObject({ state: "accepted" });
      expect((await authority.issueRecovery(command)).outcome).toBe("replayed");
      await run.run(); expect(seen).toHaveLength(1); expect(captures).toBe(1);
      expect(await protectedRows()).toEqual(before);
    } finally { await store.close(); }
  }, 30_000);

  // The shared lock and conflict completion admits the operator receipt lock on the restricted runtime.
  it("issues operator recovery through the restricted runtime with one command, notice and token", async () => {
    const f = await operatorCase(), key = `operator-recovery:${randomUUID()}`, token = createHash("sha256").update(key).digest("hex");
    const counts = async () => (await admin.query(`SELECT
      (SELECT count(*)::int FROM public.customer_recovery_commands WHERE idempotency_key=$1) AS commands,
      (SELECT count(*)::int FROM public.subscription_dunning_notifications WHERE case_id=$2::uuid AND notification_kind='payment_recovery') AS notices,
      (SELECT count(*)::int FROM public.commerce_checkout_recovery_tokens WHERE order_id=$3::uuid) AS tokens`,
    [key, f.caseId, f.orderId])).rows[0];
    expect(await counts()).toEqual({ commands: 0, notices: 0, tokens: 0 });
    const issue = async () => (await runtime.query(`SELECT public.customer_support_issue_recovery($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,
      clock_timestamp()+interval '1 day','/account/recovery') AS result`,
    [f.operator.toUpperCase(), f.client.toUpperCase(), f.caseId.toUpperCase(), key, "a".repeat(64), token])).rows[0].result;
    const issued = await issue();
    expect(issued).toMatchObject({ outcome: "issued" });
    expect(await counts()).toEqual({ commands: 1, notices: 1, tokens: 1 });
    expect(await issue()).toEqual({ ...issued, outcome: "replayed" });
    expect(await counts()).toEqual({ commands: 1, notices: 1, tokens: 1 });
  }, 30_000);

  it("refuses a missing source before recipient lookup or binding with a sanitized terminal skip", async () => {
    const f = await failure();
    const id = (await runtime.query("SELECT public.dunning_lifecycle_queue_notice($1::uuid,'payment_recovery','payment_recovery',1,NULL) AS id", [f.caseId.toUpperCase()])).rows[0].id;
    await admin.query("DELETE FROM public.subscription_dunning_notifications WHERE notification_kind='payment_failed'");
    expect(await binding(zone, accepted, { bind: async () => { throw new Error("unexpected bind"); } }).run()).toMatchObject({ skipped: 1, failed: 0 });
    expect(await notice(id)).toMatchObject({ status: "skipped", error: "notice_source_unavailable" });
  }, 30_000);

  it("requeues returned transient and unspecified failures at two SQL-clock seconds, but makes final failure unclaimable", async () => {
    const parcel = await parcelFixture(admin);
    // Synthetic pre-existing alignment obligation for conservation, with default admission policy retained.
    await admin.query(`INSERT INTO public.subscription_delivery_alignment_cases(shipment_id,predecessor_order_id,
      subscription_id,predecessor_cycle_id,predecessor_cycle_number,captured_mode,state,evidence_kind)
      VALUES($1,$2,$3,$4,1,'protect','protected','fulfillment_exception')`,
    [parcel.shipment, parcel.order, parcel.subscription, parcel.cycle]);
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '90 days'");
    const f = await failure(), before = await protectedRows();
    let sends = 0;
    const run = binding(zone, { readReceipt: async () => null, send: async () => {
      sends++; return sends <= 2 ? { state: "failed", deliveryReference: null, ...(sends === 1 ? { retryable: true } : {}) }
        : { state: "accepted", deliveryReference: "captured:retry" };
    } }, { dispatch: { leaseSeconds: 7, maxAttempts: 4, transientBackoffSeconds: 2 } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = (await runtime.query("SELECT clock_timestamp() AS at")).rows[0].at;
      expect(await run.run()).toMatchObject({ requeued: 1, failed: 0 });
      const row = await notice(f.noticeId);
      expect(row).toMatchObject({ status: "queued", attempt_count: attempt + 1, claim_token: null });
      expect((await runtime.query("SELECT $1::timestamptz >= $2::timestamptz+interval '2 seconds' AS delayed", [row.scheduled_text, start])).rows[0].delayed).toBe(true);
      expect((await runtime.query("SELECT * FROM public.subscription_dunning_claim_batch(100,7,4)")).rows).toEqual([]);
      await runtime.query("SELECT pg_sleep(2.05)");
    }
    expect(await run.run()).toMatchObject({ sent: 1 });
    expect(sends).toBe(3);
    expect(await protectedRows()).toEqual(before);
    const final = await failure();
    const beforeFinal = await protectedRows();
    expect(await binding(zone, { readReceipt: async () => null, send: async () => ({ state: "failed", deliveryReference: null, retryable: false }) }).run()).toMatchObject({ failed: 1, requeued: 0 });
    expect(await notice(final.noticeId)).toMatchObject({ status: "failed", error: "notice_delivery_rejected" });
    expect((await runtime.query("SELECT * FROM public.subscription_dunning_claim_batch(100,7,4)")).rows).toEqual([]);
    expect(await protectedRows()).toEqual(beforeFinal);
  }, 30_000);

  it("passes nondefault lease and attempt ceiling to SQL and rejects both stale finalizers after takeover", async () => {
    const f = await failure();
    await binding(zone, accepted, { dispatch: { leaseSeconds: 7, maxAttempts: 2 }, bind: async () => { throw new Error("synthetic bind fault"); } }).run();
    const first = await notice(f.noticeId);
    expect(first.status).toBe("sending");
    expect((await runtime.query("SELECT extract(epoch FROM lease_expires_at-updated_at)::int AS lease FROM public.subscription_dunning_notifications WHERE id=$1", [f.noticeId])).rows[0].lease).toBe(7);
    await admin.query("UPDATE public.subscription_dunning_notifications SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [f.noticeId]);
    const second = (await runtime.query("SELECT * FROM public.subscription_dunning_claim_batch(100,7,2)")).rows[0];
    expect(second.claim_token).not.toBe(first.claim_token);
    expect((await runtime.query("SELECT public.subscription_dunning_mark_sent($1::uuid,$2::uuid,'captured:stale') AS ok", [f.noticeId.toUpperCase(), first.claim_token.toUpperCase()])).rows[0].ok).toBe(false);
    expect((await runtime.query("SELECT public.subscription_dunning_mark_result($1::uuid,$2::uuid,'queued','stale',now()) AS ok", [f.noticeId.toUpperCase(), first.claim_token.toUpperCase()])).rows[0].ok).toBe(false);
    await admin.query("UPDATE public.subscription_dunning_notifications SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [f.noticeId]);
    let binds = 0;
    expect(await binding(zone, accepted, { dispatch: { maxAttempts: 2 }, bind: async () => { binds++; throw new Error("unexpected bind"); } }).run()).toMatchObject({ sent: 0, failed: 0 });
    expect(binds).toBe(0);
    expect((await notice(f.noticeId)).attempt_count).toBe(2);
  }, 30_000);

  it.each(["read", "bind", "send", "acceptance_ack", "finalize"] as const)("keeps a thrown %s error sending and reconciles accepted history before binding", async fault => {
    const f = await failure();
    const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
    const captureRoot = `.context/scratch/v/captured/${randomUUID()}`;
    await mkdir(captureRoot, { recursive: true, mode: 0o700 });
    let captures = 0, broken = true;
    const deliver = createTransactionalDelivery({ store, delivery: { async deliver(command: Command) {
      const path = `${captureRoot}/${createHash("sha256").update(command.idempotencyKey).digest("hex")}.json`;
      const body = JSON.stringify({ template: command.templateReference, body: "Payment needs attention. Service continues." });
      try { await writeFile(path, body, { flag: "wx", mode: 0o600 }); captures++; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; expect(await readFile(path, "utf8")).toBe(body); }
      if (fault === "send" && broken) { broken = false; throw new Error("synthetic lost capture acknowledgement"); }
      return { deliveryReference: `captured:${command.idempotencyKey}` };
    } } });
    const before = await protectedRows();
    try {
      const run = binding(zone, { async send(command) {
        const receipt = await deliver.send(command);
        if (fault === "acceptance_ack" && broken) { broken = false; throw new Error("synthetic accepted acknowledgement fault"); }
        return receipt;
      }, async readReceipt(key) {
        if (fault === "read" && broken) { broken = false; throw new Error("synthetic receipt read fault"); }
        return store.readReceipt(key);
      } }, {
        async bind(value) {
          if (fault === "bind" && broken) { broken = false; throw new Error("synthetic bind fault"); }
          return { recipientReference: `client:${value.clientId}`, templateReference: value.templateSlug };
        },
        async query(sql, values) {
          if (fault === "finalize" && broken && sql.includes("subscription_dunning_mark_sent")) { broken = false; throw new Error("synthetic finalization fault"); }
          return { sql, values };
        },
      });
      expect((await run.run()).failed).toBe(1);
      expect((await notice(f.noticeId)).status).toBe("sending");
      await admin.query("UPDATE public.subscription_dunning_notifications SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [f.noticeId]);
      // A new binding/process-equivalent instance shares only the durable capture and receipt.
      const resumed = binding(zone, { send: deliver.send, readReceipt: store.readReceipt }, {
        bind: ["finalize", "acceptance_ack"].includes(fault) ? async () => { throw new Error("accepted receipt must precede bind"); } : undefined,
      });
      expect(await resumed.run()).toMatchObject(["finalize", "acceptance_ack"].includes(fault) ? { replayed: 1 } : { sent: 1 });
      expect((await notice(f.noticeId)).status).toBe("sent");
      await resumed.run(); expect(captures).toBe(1);
      expect(await protectedRows()).toEqual(before);
    } finally { await store.close(); }
  }, 30_000);

  it("bounds unreceipted recovery by current case truth and one-hour recency while reconciling old accepted history", async () => {
    const recent = await failure(), old = await failure(), changed = await failure(), acknowledged = await failure();
    const ids: string[] = [];
    for (const f of [recent, old, changed, acknowledged]) {
      const result = (await runtime.query("SELECT public.dunning_lifecycle_record_recovery($1::uuid,now(),'subscription-payment-recovered') AS result", [f.caseId.toUpperCase()])).rows[0].result;
      ids.push(String(result.notificationId));
    }
    await admin.query("UPDATE public.subscription_dunning_cases SET recovered_at=now()-interval '2 hours' WHERE id=ANY($1::uuid[])", [[old.caseId, acknowledged.caseId]]);
    await admin.query("UPDATE public.subscription_dunning_cases SET status='open',recovered_at=NULL WHERE id=$1", [changed.caseId]);
    const seen: string[] = [];
    const run = binding(zone, { async readReceipt(key) {
      return key.endsWith(ids[3]!) ? { state: "accepted", deliveryReference: "captured:old" } : null;
    }, async send(command) { seen.push(command.idempotencyKey); return { state: "accepted", deliveryReference: "captured:recent" }; } }, { recovered: { windowSeconds: 3600 } });
    const before = await protectedRows();
    expect(await run.run()).toMatchObject({ sent: 1, skipped: 2, replayed: 1 });
    expect(seen).toEqual([`subscription-notice:dunning:${ids[0]}`]);
    for (const id of [ids[1]!, ids[2]!]) expect(await notice(id)).toMatchObject({ status: "skipped", error: "notice_recovery_ineligible" });
    await run.run(); expect(seen).toHaveLength(1);
    expect(await protectedRows()).toEqual(before);
  }, 30_000);

  it("includes the exact SQL timestamp cutoff and excludes one microsecond earlier", async () => {
    const inside = await failure(), outside = await failure();
    // Sample the real SQL clock once, then hold that comparison instant through the executor.
    const sampled = (await runtime.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at")).rows[0].at;
    await runtime.query("SELECT public.dunning_lifecycle_record_recovery($1::uuid,$2::timestamptz-interval '1 hour','subscription-payment-recovered')", [inside.caseId.toUpperCase(), sampled]);
    await runtime.query("SELECT public.dunning_lifecycle_record_recovery($1::uuid,$2::timestamptz-interval '1 hour 0.000001 seconds','subscription-payment-recovered')", [outside.caseId.toUpperCase(), sampled]);
    const seen: string[] = [];
    const result = await binding(zone, accepted, { recovered: { windowSeconds: 3600 }, async bind(value) {
      seen.push(value.subscriptionId); return { recipientReference: `client:${value.clientId}`, templateReference: value.templateSlug };
    }, async query(sql, values) {
      if (sql.includes("recovered_at>=")) return { sql: sql.replace("clock_timestamp()", "$5::timestamptz"), values: [...values, sampled] };
      return { sql, values };
    } }).run();
    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect(seen).toEqual([inside.subscription]);
  }, 30_000);
});
