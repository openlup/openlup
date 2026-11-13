import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPaymentTruthPort, createPostgresSandboxPaymentSimulator, paymentTruthFingerprint, paymentSchemaDescriptor } from "@openlup/platform/payments";
import type { SandboxPaymentAttempt, SandboxPaymentObservation, SandboxPaymentOutcome } from "@openlup/platform/payments/contracts";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, admin: Pool, runtime: Pool, runtimeUrl: string;
const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "postgres", bootstrapLogin: "postgres", runtimeLogin: "m19_pay_runtime", restoreLogin: "m19_pay_restore" };
const options = { dunningTemplateSlug: "payment_failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "payment_recovered" };
const at = "2026-10-30T12:00:00.123Z";
const simulator = () => createPostgresSandboxPaymentSimulator(runtime, options);
const truth = () => createPostgresPaymentTruthPort(runtime, options);
beforeAll(async () => {
  container = await runPostgresContainer({ name: `m19-pay-${process.pid}`, password: "synthetic-conformance" });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  admin = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  for (const name of ["m19_pay_runtime", "m19_pay_restore"]) await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => admin }).apply();
  const url = new URL(container.connectionString); url.username = selection.runtimeLogin; runtimeUrl = url.toString();
  runtime = new Pool({ connectionString: runtimeUrl, options: "-c lock_timeout=150ms" });
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [runtime, admin]); }, postgresTeardownTimeoutMs);

async function fixture(channel = "sandbox", subscription = false) {
  const client = randomUUID(), order = randomUUID(), sub = randomUUID(), cycle = randomUUID();
  await admin.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  if (subscription) {
    await admin.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2026-08-29T12:00:00Z')", [sub, client]);
    await admin.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at) VALUES($1,$2,'2026-08-01T12:00:00Z')", [cycle, sub]);
  }
  const setup = await admin.connect();
  try {
    await setup.query("BEGIN");
    await setup.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,currency_code,total_amount_minor) VALUES($1,$2,$3,'XXX',900)", [order, client, subscription ? cycle : null]);
    await setup.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)", [order]);
    await setup.query("COMMIT");
  } catch (error) { await setup.query("ROLLBACK"); throw error; } finally { setup.release(); }
  const response = (await runtime.query("SELECT public.commerce_open_settlement_intent($1,$2,$3,900,'XXX','{}'::jsonb,$4) AS response", [`open:${order}`, order, channel, at])).rows[0].response;
  const intent = (await admin.query("SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1", [order])).rows[0].id as string;
  expect(response).toBeTruthy();
  return { order, intent, sub, cycle };
}
function begin(intent: string, key = randomUUID()) { return { settlementIntentId: intent, idempotencyKey: `attempt:${key}`, requestFingerprint: "b".repeat(64), at }; }
function delivery(a: SandboxPaymentAttempt, id: string) { return { settlementIntentId: a.settlementIntentId, attemptId: a.id, observationId: id }; }
function receive(a: SandboxPaymentAttempt, id: string) { return simulator().ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify(delivery(a, id))), headers: {}, receivedAt: at }); }
async function observe(a: SandboxPaymentAttempt, outcome: SandboxPaymentOutcome) {
  const input = { attemptId: a.id, idempotencyKey: `event:${randomUUID()}`, outcome, occurredAt: at };
  const result = await simulator().recordObservation(input);
  return { input, ...result };
}
function evidence(a: SandboxPaymentAttempt, e: SandboxPaymentObservation) {
  return { sourceKind: "reconciliation_read" as const, sourceReference: e.id, observedStatus: e.outcome,
    observedAt: new Date(e.occurredAt).toISOString(), payloadFingerprint: e.fingerprint, attemptRef: a.id };
}
async function eventFor(observation: string) {
  return (await admin.query("SELECT * FROM public.payment_truth_events WHERE source_event_id=$1", [`sandbox:${observation}`])).rows[0];
}
interface RestartResult {
  before: SandboxPaymentAttempt;
  begun: SandboxPaymentAttempt & { replayed: boolean };
  response: { status: number; data: { replayed: boolean } };
}
async function restart(input: Record<string, unknown>) {
  return await new Promise<RestartResult>((resolve, reject) => {
    const child = execFile(process.execPath, ["--experimental-strip-types", "tests/postgres/m19PaymentSimulatorChild.ts"], { timeout: 15_000, maxBuffer: 100_000 }, (error, stdout) => {
      if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); } }
    });
    child.stdin!.end(JSON.stringify({ connectionString: runtimeUrl, options, ...input }));
  });
}
async function financial(order: string) { return (await admin.query("SELECT status FROM public.commerce_orders WHERE id=$1", [order])).rows[0].status; }

it("confines four pinned definers, refuses direct runtime table access and keeps real providers unsupported", async () => {
  expect((await runtime.query("SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false }]);
  const defs = (await admin.query(`SELECT prosecdef,proconfig,
    has_function_privilege('anon',oid,'EXECUTE') AS browser,
    has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
    has_function_privilege('m19_pay_runtime',oid,'EXECUTE') AS runtime
    FROM pg_proc WHERE proname LIKE 'payment_simulator_%'`)).rows;
  expect(defs).toHaveLength(4);
  expect(defs.every(d => d.prosecdef && d.proconfig.join() === "search_path=pg_catalog, pg_temp"
    && !d.browser && !d.authenticated && d.runtime)).toBe(true);
  for (const table of ["payment_simulator_attempts", "payment_simulator_observations"]) {
    for (const sql of [`SELECT * FROM public.${table}`, `INSERT INTO public.${table}(id) VALUES(gen_random_uuid())`, `UPDATE public.${table} SET id=gen_random_uuid()`]) {
      await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
  }
  const browser = await runtime.connect();
  try {
    for (const role of ["anon", "authenticated"]) {
      await browser.query(`SET ROLE ${role}`);
      await expect(browser.query("SELECT public.payment_simulator_read_attempt(NULL,NULL)")).rejects.toMatchObject({ code: "42501" });
      await browser.query("RESET ROLE");
    }
  } finally { await browser.query("RESET ROLE"); browser.release(); }
  expect(paymentSchemaDescriptor.preparedDurableStore).toBe("supported");
  const f = await fixture("future-provider");
  await expect(simulator().beginAttempt(begin(f.intent))).rejects.toThrow("native_prepared_attempt_store_unsupported");
});

it("narrows hostile default table grants without blocking the restricted simulator routines", async () => {
  const resource = await runPostgresContainer({ name: `m19-pay-defaults-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [];
  try {
    expect(await waitForPostgresTcpReady(resource.connectionString)).toBe(true);
    const owner = new Pool({ connectionString: resource.connectionString, max: 1 }); pools.push(owner);
    const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
    const forward = "db/platform/migrations/20261101222000_sandbox_payment_attempts.sql";
    const units = [manifest.baseline, ...manifest.forward];
    const forwardIndex = units.findIndex(unit => unit.file === forward);
    expect(units.filter(unit => unit.file === forward)).toHaveLength(1);
    for (const unit of units.slice(0, forwardIndex)) await owner.query(readFileSync(unit.file, "utf8"));
    await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS");
    await owner.query("CREATE ROLE m19_default_runtime LOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD 'synthetic-conformance'; GRANT service_role TO m19_default_runtime");
    await owner.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role");
    await owner.query("CREATE TABLE public.default_grant_witness(id uuid)");
    for (const role of ["anon", "authenticated", "service_role", "m19_default_runtime"]) {
      expect((await owner.query("SELECT has_table_privilege($1,'public.default_grant_witness','SELECT') AS exposed", [role])).rows[0].exposed).toBe(true);
    }
    await owner.query(readFileSync(forward, "utf8"));
    for (const table of ["payment_simulator_attempts", "payment_simulator_observations"]) {
      const relation = `public.${table}`;
      expect((await owner.query("SELECT relrowsecurity, EXISTS(SELECT 1 FROM aclexplode(relacl) WHERE grantee=0) AS public_grant FROM pg_class WHERE oid=$1::regclass", [relation])).rows)
        .toEqual([{ relrowsecurity: false, public_grant: false }]);
      for (const role of ["anon", "authenticated", "service_role", "m19_default_runtime"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          expect((await owner.query("SELECT has_table_privilege($1,$2,$3) AS exposed", [role, relation, privilege])).rows[0].exposed).toBe(false);
        }
      }
    }
    const url = new URL(resource.connectionString); url.username = "m19_default_runtime";
    const restricted = new Pool({ connectionString: url.toString() }); pools.push(restricted);
    expect((await restricted.query("SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false }]);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const browser = await owner.connect();
      try {
        await browser.query(`SET ROLE ${role}`);
        for (const table of ["payment_simulator_attempts", "payment_simulator_observations"]) {
          await expect(browser.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
        }
      } finally { await browser.query("RESET ROLE"); browser.release(); }
    }
    const client = randomUUID(), order = randomUUID(), intent = randomUUID();
    await owner.query("BEGIN");
    try {
      await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
      await owner.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',900)", [order, client]);
      await owner.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)", [order]);
      await owner.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES($1,$2,'sandbox',900,'XXX',$3)", [intent, order, `open:${intent}`]);
      await owner.query("COMMIT");
    } catch (error) { await owner.query("ROLLBACK"); throw error; }
    const port = createPostgresSandboxPaymentSimulator(restricted, options);
    const attempt = await port.beginAttempt(begin(intent));
    const observation = await port.recordObservation({ attemptId: attempt.id, idempotencyKey: randomUUID(), outcome: "captured", occurredAt: at });
    expect(await port.readAttempt({ settlementIntentId: intent })).toMatchObject({ id: attempt.id, latestObservation: { id: observation.id, outcome: "captured" } });
    const latest = (await port.readAttempt({ settlementIntentId: intent }))!.latestObservation!;
    await restricted.query("SELECT public.payment_simulator_assert_truth($1,'captured',900,'XXX',$2,$3::jsonb)", [intent, at, JSON.stringify(evidence(attempt, latest))]);
    await expect(restricted.query("SELECT * FROM public.payment_simulator_attempts")).rejects.toMatchObject({ code: "42501" });
  } finally { await closePostgres(resource, pools); }
}, postgresSetupTimeoutMs);

it("refuses browser-return paid claims and fake observations before any financial effect", async () => {
  const f = await fixture(), a = await simulator().beginAttempt(begin(f.intent));
  const browser = await simulator().ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({ settlementIntentId: f.intent, status: "succeeded" })), headers: {}, receivedAt: at });
  expect(browser.status).toBe(400);
  expect((await receive(a, randomUUID())).status).toBe(400);
  await expect(truth().ingestEvent({ sourceEventId: `sandbox:${randomUUID()}`, idempotencyKey: randomUUID(), settlementIntentId: f.intent,
    outcome: "captured", amountMinor: 900, currency: "XXX", occurredAt: at, failure: null,
    evidence: { sourceKind: "accepted_event", sourceReference: randomUUID(), observedStatus: "captured", observedAt: at, payloadFingerprint: "a".repeat(64) } })).rejects.toThrow("wrong_attempt");
  expect(await financial(f.order)).toBe("pending_payment");
});

it("replays begin/observations/capture after a fresh process and commits one financial effect", async () => {
  const f = await fixture(), input = begin(f.intent);
  const [a, b] = await Promise.all([simulator().beginAttempt(input), simulator().beginAttempt(input)]);
  expect(a.id).toBe(b.id); expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  await expect(simulator().beginAttempt({ ...input, requestFingerprint: "c".repeat(64) })).rejects.toMatchObject({ code: "23505" });
  const e = await observe(a, "captured");
  expect(await simulator().recordObservation(e.input)).toEqual({ id: e.id, replayed: true });
  await expect(simulator().recordObservation({ ...e.input, outcome: "refused" })).rejects.toMatchObject({ code: "23505" });
  const observation = (await simulator().readAttempt({ settlementIntentId: f.intent }))!.latestObservation!;
  const acceptedEvidence = { ...evidence(a, observation), sourceKind: "accepted_event" as const };
  const assertionInput = { sourceEventId: `sandbox:${e.id}`, idempotencyKey: `sandbox:ingest:${e.id}`, settlementIntentId: f.intent,
    outcome: "captured" as const, amountMinor: 900, currency: "XXX", occurredAt: at, failure: null, evidence: acceptedEvidence };
  await expect(truth().ingestEvent({ ...assertionInput, amountMinor: 901 })).rejects.toThrow("payment_simulator_evidence_mismatch");
  await expect(truth().ingestEvent({ ...assertionInput, currency: "YYY" })).rejects.toThrow("payment_simulator_evidence_mismatch");
  const wrongAttemptEvidence = { ...acceptedEvidence, attemptRef: randomUUID() };
  await expect(truth().ingestEvent({ ...assertionInput, evidence: wrongAttemptEvidence })).rejects.toThrow("wrong_attempt");
  expect(await eventFor(e.id)).toBeUndefined();
  expect((await receive(a, e.id)).status).toBe(200);
  const replay = await restart({ identity: { settlementIntentId: f.intent }, begin: input, delivery: delivery(a, e.id) });
  expect(replay.before.id).toBe(a.id); expect(replay.begun.replayed).toBe(true);
  expect(replay.response).toMatchObject({ status: 200, data: { replayed: true } });
  expect(await financial(f.order)).toBe("paid");
  expect((await admin.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.intent])).rows).toHaveLength(1);
  expect((await admin.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.paid'", [f.order])).rows).toHaveLength(1);
  expect((await admin.query("SELECT id FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1", [f.intent])).rows).toHaveLength(1);
});

it("settles concurrent first ingresses across session zones without a false conflict", async () => {
  const f = await fixture(), a = await simulator().beginAttempt(begin(f.intent));
  const observation = await simulator().recordObservation({ attemptId: a.id, idempotencyKey: randomUUID(),
    outcome: "captured", occurredAt: "2026-10-30T12:00:00.123456Z" });
  const utc = await runtime.connect(), offset = await runtime.connect();
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const readBeforeCommit = new Promise<void>(resolve => { reached = resolve; });
  let pending: ReturnType<typeof receive> | undefined;
  try {
    await utc.query("SET TimeZone='UTC'"); await offset.query("SET TimeZone='Etc/GMT-9'");
    expect((await offset.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const second = createPostgresSandboxPaymentSimulator({ async query(sql, values) {
      const result = await offset.query(sql, values);
      if (sql.includes("FROM public.payment_truth_events") && sql.includes("source_event_id=$1") && !result.rows.length) {
        reached(); await barrier;
      }
      return result;
    } }, options);
    const request = { rawBody: new TextEncoder().encode(JSON.stringify(delivery(a, observation.id))), headers: {}, receivedAt: at };
    pending = second.ingress.receive(request);
    await Promise.race([readBeforeCommit, pending.then(() => { throw new Error("interleaving_barrier_not_reached"); })]);
    expect(await createPostgresSandboxPaymentSimulator(utc, options).ingress.receive(request))
      .toMatchObject({ status: 200, data: { replayed: false } });
    release();
    expect(await pending).toMatchObject({ status: 200, data: { replayed: true } });
    expect((await admin.query(`SELECT
      (SELECT count(*)::int FROM public.payment_truth_events WHERE settlement_intent_id=$1) AS truth,
      (SELECT count(*)::int FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1) AS dispatches,
      (SELECT count(*)::int FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded') AS captures`, [f.intent])).rows)
      .toEqual([{ truth: 1, dispatches: 1, captures: 1 }]);
    expect(await financial(f.order)).toBe("paid");
  } finally {
    release(); await pending?.catch(() => undefined);
    await utc.query("RESET TimeZone"); await offset.query("RESET TimeZone"); utc.release(); offset.release();
  }
});

it("returns identical attempt time facts across sessions and replays equivalent observation instants", async () => {
  const f = await fixture(), utc = await runtime.connect(), offset = await runtime.connect();
  try {
    await utc.query("SET TimeZone='UTC'"); await offset.query("SET TimeZone='Etc/GMT-9'");
    const source = createPostgresSandboxPaymentSimulator(utc, options), target = createPostgresSandboxPaymentSimulator(offset, options);
    const a = await source.beginAttempt({ ...begin(f.intent), methodFacts: methodFacts("2026-10-30T12:00:00.123456Z") });
    const input = { attemptId: a.id, idempotencyKey: randomUUID(), outcome: "captured" as const, occurredAt: "2026-10-30T12:00:00.123456Z" };
    const observation = await source.recordObservation(input);
    expect(await target.recordObservation({ ...input, occurredAt: "2026-10-30T14:00:00.123456+02:00" }))
      .toEqual({ id: observation.id, replayed: true });
    expect(await target.readAttempt({ settlementIntentId: f.intent })).toEqual(await source.readAttempt({ settlementIntentId: f.intent }));
    await expect(target.recordObservation({ ...input, occurredAt: "2026-10-30T12:00:00.123457Z" })).rejects.toMatchObject({ code: "23505" });
  } finally {
    await utc.query("RESET TimeZone"); await offset.query("RESET TimeZone"); utc.release(); offset.release();
  }
});

function methodFacts(unattendedChargeAuthorizedAt: string) {
  return { authorizationRef: "sandbox:authorization:explicit", unattendedChargeAuthorizedAt,
    payerAccountRef: "sandbox:payer:explicit", methodRef: "sandbox:method:explicit", methodEvidenceRef: "sandbox:evidence:explicit" };
}
async function attemptRows(intent: string) {
  return (await admin.query(`SELECT id,xmin::text AS version,dispatched_at::text AS dispatched_at,state,
    (SELECT count(*)::int FROM public.payment_simulator_observations WHERE attempt_id=a.id) AS observations
    FROM public.payment_simulator_attempts a WHERE settlement_intent_id=$1`, [intent])).rows;
}
it.each([
  "2026-10-30T12:00:00.123456Z", "2026-10-30T12:00:00.000Z", "2026-10-30T14:00:00.123456+02:00",
])("replays explicit method facts without redispatch for %s", async authorizationAt => {
  expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ rolsuper: false, rolbypassrls: false }]);
  const f = await fixture(), input = { ...begin(f.intent), methodFacts: methodFacts(authorizationAt) };
  const first = await simulator().beginAttempt(input), before = await attemptRows(f.intent);
  expect(first.replayed).toBe(false); expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ id: first.id, state: "dispatched", observations: 0 });
  expect(await simulator().beginAttempt(input)).toMatchObject({ id: first.id, replayed: true });
  expect(await attemptRows(f.intent)).toEqual(before);
});
it("replays explicit method facts read in a different session TimeZone", async () => {
  const f = await fixture(), input = begin(f.intent), utc = await runtime.connect(), offsetSession = await runtime.connect();
  try {
    await utc.query("SET TimeZone='UTC'"); await offsetSession.query("SET TimeZone='Etc/GMT-9'");
    const source = createPostgresSandboxPaymentSimulator(utc, options);
    const target = createPostgresSandboxPaymentSimulator(offsetSession, options);
    const first = await source.beginAttempt(input), saved = (await source.readAttempt({ settlementIntentId: f.intent }))!.methodFacts;
    const before = await attemptRows(f.intent);
    expect(await target.beginAttempt({ ...input, methodFacts: saved })).toMatchObject({ id: first.id, replayed: true });
    const other = (await target.readAttempt({ settlementIntentId: f.intent }))!.methodFacts;
    expect(await source.beginAttempt({ ...input, methodFacts: other })).toMatchObject({ id: first.id, replayed: true });
    expect(await attemptRows(f.intent)).toEqual(before);
  } finally {
    await utc.query("RESET TimeZone"); await offsetSession.query("RESET TimeZone"); utc.release(); offsetSession.release();
  }
});
it.each([
  { unattendedChargeAuthorizedAt: "2026-10-30T12:00:00.123457Z" }, { methodRef: "sandbox:method:changed" },
])("refuses changed explicit method facts %j", async changed => {
  const f = await fixture(), input = { ...begin(f.intent), methodFacts: methodFacts("2026-10-30T12:00:00.123456Z") };
  await simulator().beginAttempt(input); const before = await attemptRows(f.intent);
  await expect(simulator().beginAttempt({ ...input, methodFacts: { ...input.methodFacts, ...changed } }))
    .rejects.toMatchObject({ code: "23505", message: "payment_simulator_request_conflict" });
  expect(await attemptRows(f.intent)).toEqual(before);
});
it("refuses invalid explicit authorization timestamp strings on creation and replay", async () => {
  const f = await fixture(), input = begin(f.intent), invalid = methodFacts("not-a-timestamp");
  await expect(simulator().beginAttempt({ ...input, methodFacts: invalid })).rejects.toMatchObject({ code: "22007" });
  expect(await attemptRows(f.intent)).toEqual([]);
  await simulator().beginAttempt(input); const before = await attemptRows(f.intent);
  await expect(simulator().beginAttempt({ ...input, methodFacts: invalid })).rejects.toMatchObject({ code: "22007" });
  expect(await attemptRows(f.intent)).toEqual(before);
});

it("preserves sub-millisecond observation times through fresh ingress and replay", async () => {
  expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ rolsuper: false, rolbypassrls: false }]);
  const f = await fixture(), precise = "2026-10-30T12:00:00.123456Z";
  const a = await simulator().beginAttempt({ ...begin(f.intent), at: precise });
  const e = await simulator().recordObservation({ attemptId: a.id, idempotencyKey: `precise:${randomUUID()}`,
    outcome: "captured", occurredAt: precise });
  const request = { rawBody: new TextEncoder().encode(JSON.stringify(delivery(a, e.id))), headers: {},
    receivedAt: "2026-10-30T12:00:01.000Z" };
  expect(await simulator().ingress.receive(request)).toMatchObject({ status: 200, data: { replayed: false } });
  const effects = async () => (await admin.query(`SELECT
    (SELECT status FROM public.commerce_settlement_intents WHERE id=$1) AS status,
    (SELECT count(*)::int FROM public.payment_truth_events WHERE settlement_intent_id=$1) AS truth,
    (SELECT count(*)::int FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1) AS dispatches,
    (SELECT count(*)::int FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded') AS captures`,
  [f.intent])).rows[0];
  const truthRows = async () => (await admin.query(`SELECT xmin::text AS version,event_fingerprint,source_evidence,
    occurred_at=$2::timestamptz AND (source_evidence->>'observedAt')::timestamptz=$2::timestamptz AS precise
    FROM public.payment_truth_events WHERE settlement_intent_id=$1`, [f.intent, precise])).rows;
  expect(await effects()).toEqual({ status: "settled", truth: 1, dispatches: 1, captures: 1 });
  const accepted = await truthRows(), dispatched = await simulator().readAttempt({ settlementIntentId: f.intent });
  expect(accepted).toHaveLength(1); expect(accepted[0].precise).toBe(true);
  expect(await simulator().ingress.receive(request)).toMatchObject({ status: 200, data: { replayed: true } });
  expect(await effects()).toEqual({ status: "settled", truth: 1, dispatches: 1, captures: 1 });
  expect(await truthRows()).toEqual(accepted);
  expect(await simulator().readAttempt({ settlementIntentId: f.intent })).toEqual(dispatched);
});

for (const outcome of ["refused", "expired"] as const) it(`replays ${outcome} after restart, then accepts one late capture for the same active attempt`, async () => {
  const f = await fixture(), input = begin(f.intent), a = await simulator().beginAttempt(input), e = await observe(a, outcome);
  expect((await receive(a, e.id)).status).toBe(200); expect(await financial(f.order)).toBe("pending_payment");
  const replay = await restart({ identity: { settlementIntentId: f.intent }, begin: input, delivery: delivery(a, e.id) });
  expect(replay.before.state).toBe(outcome); expect(replay.response.data.replayed).toBe(true);
  const late = await observe(a, "captured"); expect((await receive(a, late.id)).status).toBe(200);
  expect((await receive(a, e.id))).toMatchObject({ status: 200, data: { replayed: true } });
  expect((await receive(a, late.id))).toMatchObject({ status: 200, data: { replayed: true } });
  expect(await financial(f.order)).toBe("paid");
});

it("refuses wrong and stale attempts after restart using only the database active-attempt fence", async () => {
  const f = await fixture(), input = begin(f.intent), a = await simulator().beginAttempt(input), e = await observe(a, "refused");
  expect((await receive(a, e.id)).status).toBe(200);
  const next = await simulator().beginAttempt(begin(f.intent)); expect(next.id).not.toBe(a.id);
  const stale = await restart({ command: "stale", observation: { ...e.input, idempotencyKey: randomUUID(), outcome: "captured" } });
  expect(stale).toEqual({ refused: true, reason: "wrong_attempt" });
  await expect(simulator().recordObservation({ ...e.input, attemptId: randomUUID(), idempotencyKey: randomUUID() })).rejects.toThrow("wrong_attempt");
  const latest = (await simulator().readAttempt({ settlementIntentId: f.intent, attemptId: a.id }))!;
  await expect(runtime.query("SELECT public.payment_simulator_assert_truth($1,'refused',900,'XXX',$2,$3::jsonb)", [f.intent, at, JSON.stringify(evidence(a, latest.latestObservation!))])).rejects.toThrow("wrong_attempt");
  expect((await receive(a, e.id))).toMatchObject({ status: 200, data: { replayed: true } });
  expect(await financial(f.order)).toBe("pending_payment");
  const unseen = await fixture(), originalInput = begin(unseen.intent), originalAttempt = await simulator().beginAttempt(originalInput);
  const unseenEvent = await observe(originalAttempt, "refused");
  await simulator().beginAttempt(begin(unseen.intent));
  const skipped = await restart({ identity: { settlementIntentId: unseen.intent, attemptId: originalAttempt.id }, begin: originalInput, delivery: delivery(originalAttempt, unseenEvent.id) });
  expect(skipped.response).toMatchObject({ status: 200, data: { skipped: "result_attempt_mismatch" } });
  expect(await eventFor(unseenEvent.id)).toBeUndefined(); expect(await financial(unseen.order)).toBe("pending_payment");
});

it("never redispatches an ambiguous attempt and reconciles its late capture once", async () => {
  const f = await fixture(), input = begin(f.intent), a = await simulator().beginAttempt(input), e = await observe(a, "indeterminate");
  expect((await receive(a, e.id)).status).toBe(200);
  const replay = await restart({ identity: { settlementIntentId: f.intent }, begin: input, delivery: delivery(a, e.id) });
  expect(replay.before.state).toBe("indeterminate"); expect(replay.begun.replayed).toBe(true); expect(replay.response.data.replayed).toBe(true);
  await expect(simulator().beginAttempt(begin(f.intent))).rejects.toThrow("payment_simulator_attempt_unresolved");
  const event = await eventFor(e.id); await observe(a, "captured");
  const latest = (await simulator().readAttempt({ settlementIntentId: f.intent }))!.latestObservation!;
  const reconcile = { eventId: event.id, idempotencyKey: randomUUID(), evidenceStatus: "observed" as const, outcome: "captured" as const,
    occurredAt: at, failure: null, evidence: evidence(a, latest) };
  expect(await truth().recordReconciliation(reconcile)).toMatchObject({ event: { state: "settled", outcome: "captured" }, financial: { orderStatus: "paid" } });
  expect((await truth().recordReconciliation(reconcile)).event.replayed).toBe(true);
  expect((await admin.query("SELECT id FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1", [f.intent])).rows).toHaveLength(1);
});

it("retains cancelled capture as a terminal review fact visible to OMS/readback and never reclaimed", async () => {
  const f = await fixture(), input = begin(f.intent), a = await simulator().beginAttempt(input);
  const unknown = await observe(a, "indeterminate"); expect((await receive(a, unknown.id)).status).toBe(200);
  const pending = await eventFor(unknown.id);
  await expect(runtime.query("SELECT public.oms_cancel_unpaid_order($1,$2,'buyer cancelled')", [`cancel:${f.order}`, f.order]))
    .rejects.toMatchObject({ code: "23505", message: "oms_cancel_unpaid_order_payment_already_moved" });
  // Historical cancellation can predate the operator guard; late evidence still needs review.
  await admin.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [f.order]);
  const e = await observe(a, "captured"); expect((await receive(a, e.id)).status).toBe(200);
  const event = await eventFor(e.id);
  expect(event.state).toBe("open"); expect(event.outcome).toBe("captured"); expect(event.review_required_at).toBeInstanceOf(Date); expect(event.settlement_transition_id).toBeNull();
  await expect(runtime.query("UPDATE public.payment_truth_events SET outcome='indeterminate' WHERE id=$1", [event.id]))
    .rejects.toMatchObject({ code: "23514", constraint: "payment_truth_events_review_terminal_check" });
  expect(await truth().readEvent(event.id)).toMatchObject({ event: { applicationStatus: "review_required", state: "open", outcome: "captured" }, effects: { paymentResultRecorded: false }, financial: { orderStatus: "cancelled" } });
  expect(await truth().readEvent(pending.id)).toMatchObject({ event: { applicationStatus: "review_required", outcome: "captured" } });
  const latest = (await simulator().readAttempt({ settlementIntentId: f.intent }))!.latestObservation!;
  const reconcile = { eventId: event.id, idempotencyKey: randomUUID(), evidenceStatus: "observed" as const, outcome: "captured" as const, occurredAt: at, failure: null, evidence: evidence(a, latest) };
  expect((await truth().recordReconciliation(reconcile)).event.applicationStatus).toBe("review_required");
  expect((await truth().recordReconciliation(reconcile)).event.replayed).toBe(true);
  expect((await admin.query("SELECT applied_at FROM public.payment_truth_reconciliation_evidence WHERE event_id=$1", [event.id])).rows).toEqual([{ applied_at: null }]);
  for (let n = 0; n < 2; n++) {
    const swept = (await truth().sweepOpenEvents({ now: "2030-01-01T00:00:00Z", limit: 1000 })).eventIds;
    expect(swept).not.toContain(event.id); expect(swept).not.toContain(pending.id);
  }
  const replay = await restart({ identity: { settlementIntentId: f.intent }, begin: input, delivery: delivery(a, e.id) });
  expect(replay.response).toMatchObject({ status: 200, data: { replayed: true } });
  expect((await restart({ identity: { settlementIntentId: f.intent }, begin: input, delivery: delivery(a, unknown.id) })).response)
    .toMatchObject({ status: 200, data: { replayed: true } });
  expect((await admin.query("SELECT count(*)::int AS n FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=$1 AND e.outcome IN ('captured','indeterminate')", [f.order])).rows[0].n).toBe(2);
  expect(await financial(f.order)).toBe("cancelled");
  expect((await admin.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.intent])).rows).toEqual([]);
});

it("finds cancelled captures with the documented operator query and excludes ordinary open events", async () => {
  const ordinary = await fixture(), pending = await simulator().beginAttempt(begin(ordinary.intent));
  const unknown = await observe(pending, "indeterminate"); expect((await receive(pending, unknown.id)).status).toBe(200);
  const open = await eventFor(unknown.id);
  expect(open).toMatchObject({ state: "open", review_required_at: null });
  const cancelled = await fixture(), attempt = await simulator().beginAttempt(begin(cancelled.intent));
  await expect(runtime.query("SELECT public.oms_cancel_unpaid_order($1,$2,'buyer cancelled')", [`cancel:${cancelled.order}`, cancelled.order]))
    .rejects.toMatchObject({ code: "23505", message: "oms_cancel_unpaid_order_payment_in_flight" });
  await admin.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [cancelled.order]);
  const captured = await observe(attempt, "captured"); expect((await receive(attempt, captured.id)).status).toBe(200);
  const review = await eventFor(captured.id);
  const section = readFileSync("docs/platform/DATA_AND_MIGRATIONS.md", "utf8").split("List payments awaiting operator review:")[1];
  const query = section?.match(/```sql\n([\s\S]*?)\n```/)?.[1];
  expect(query).toBeTruthy();
  const listed = (await runtime.query(query!)).rows;
  const found = listed.find(row => row.payment_truth_event_id === review.id);
  expect(found).toMatchObject({ order_id: cancelled.order, order_status: "cancelled", currency_code: "XXX", source_event_id: `sandbox:${captured.id}` });
  expect(String(found!.amount_minor)).toBe("900"); expect(found!.review_required_at).toBeInstanceOf(Date);
  expect(listed.map(row => row.payment_truth_event_id)).not.toContain(open.id);
});

it("leaves non-sandbox truth independent while both simulator tables are exclusively locked", async () => {
  const f = await fixture("future-provider"), held = await admin.connect();
  const cold = new Pool({ connectionString: runtimeUrl, options: "-c lock_timeout=150ms", connectionTimeoutMillis: 2000 });
  try {
    await held.query("BEGIN"); await held.query("LOCK TABLE public.payment_simulator_attempts,public.payment_simulator_observations IN ACCESS EXCLUSIVE MODE");
    await cold.query("SELECT public.payment_simulator_assert_truth($1,NULL,NULL,NULL,NULL,NULL)", [f.intent]);
    const result = await createPostgresPaymentTruthPort(cold, options).ingestEvent({ sourceEventId: randomUUID(), idempotencyKey: randomUUID(), settlementIntentId: f.intent,
      outcome: "captured", amountMinor: 900, currency: "XXX", occurredAt: at, failure: null,
      evidence: { sourceKind: "accepted_event", sourceReference: "external-recorded-fact", observedStatus: "captured", observedAt: at, payloadFingerprint: "a".repeat(64) } });
    expect(result.financial.orderStatus).toBe("paid");
  } finally { await held.query("ROLLBACK"); held.release(); await closePostgres(undefined, cold); }
});

it("replays retained native truth with the inherited timestamp fingerprint dialect", async () => {
  const f = await fixture("future-provider");
  const input = { sourceEventId: randomUUID(), idempotencyKey: randomUUID(), settlementIntentId: f.intent,
    outcome: "captured" as const, amountMinor: 900, currency: "XXX", occurredAt: at, failure: null,
    evidence: { sourceKind: "accepted_event" as const, sourceReference: "external-recorded-fact",
      observedStatus: "captured", observedAt: at, payloadFingerprint: "a".repeat(64) } };
  expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ rolsuper: false, rolbypassrls: false }]);
  // Existing hosts used this same public fingerprint and production writer.
  // No row is inserted by hand and no real-provider capability is qualified.
  await runtime.query(`SELECT public.payment_truth_ingest_event(
    $1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
  [input.sourceEventId, paymentTruthFingerprint(input), input.idempotencyKey, f.intent, input.outcome,
    input.amountMinor, input.currency, input.occurredAt, null, null, JSON.stringify(input.evidence),
    options.dunningTemplateSlug, options.recoveryUrlPath, options.recoveryTemplateSlug]);
  expect(await truth().ingestEvent(input)).toMatchObject({ event: { replayed: true }, financial: { orderStatus: "paid" } });
  expect((await admin.query("SELECT id FROM public.payment_truth_events WHERE settlement_intent_id=$1", [f.intent])).rows).toHaveLength(1);
  expect((await admin.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.intent])).rows).toHaveLength(1);
});

it("redelivers the same verified capture after recovery-notice contention rolls settlement back", async () => {
  const f = await fixture("sandbox", true), input = begin(f.intent), a = await simulator().beginAttempt(input), refused = await observe(a, "refused");
  expect((await receive(a, refused.id)).status).toBe(200);
  const captured = await observe(a, "captured"), held = await admin.connect();
  try {
    await held.query("BEGIN"); await held.query("LOCK TABLE public.subscription_dunning_notifications IN SHARE MODE");
    const observation = (await simulator().readAttempt({ settlementIntentId: f.intent }))!.latestObservation!;
    await expect(truth().ingestEvent({ sourceEventId: `sandbox:${captured.id}`, idempotencyKey: `sandbox:ingest:${captured.id}`,
      settlementIntentId: f.intent, outcome: "captured", amountMinor: 900, currency: "XXX", occurredAt: at, failure: null,
      evidence: { ...evidence(a, observation), sourceKind: "accepted_event" } })).rejects.toMatchObject({ code: "55P03" });
    expect((await receive(a, captured.id)).status).toBe(503);
    expect(await eventFor(captured.id)).toBeUndefined();
    expect(await financial(f.order)).toBe("pending_payment");
    expect((await admin.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.intent])).rows).toEqual([]);
  } finally { await held.query("ROLLBACK"); held.release(); }
  const replay = await restart({ identity: { settlementIntentId: f.intent }, begin: input, delivery: delivery(a, captured.id) });
  expect(replay.before.state).toBe("captured"); expect(replay.begun.replayed).toBe(true); expect(replay.response.status).toBe(200);
  expect((await receive(a, captured.id))).toMatchObject({ status: 200, data: { replayed: true } });
  expect((await admin.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.intent])).rows).toHaveLength(1);
  expect((await admin.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.paid'", [f.order])).rows).toHaveLength(1);
  expect((await admin.query("SELECT status FROM public.subscription_dunning_cases WHERE cycle_id=$1", [f.cycle])).rows).toEqual([{ status: "recovered" }]);
  expect((await admin.query("SELECT recipient_kind,notification_kind,status,error FROM public.subscription_dunning_notifications WHERE case_id=(SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=$1) ORDER BY recipient_kind,notification_kind", [f.cycle])).rows).toEqual([
    { recipient_kind: "customer", notification_kind: "payment_failed", status: "skipped", error: "case_recovered" },
    { recipient_kind: "customer", notification_kind: "payment_recovered", status: "queued", error: null },
    { recipient_kind: "operator", notification_kind: "payment_failed", status: "skipped", error: "missing_critical_notification_recipient" },
  ]);
});


it("reuses saved purchase facts through the real jsonb driver without resetting authorization time", async () => {
  const f = await fixture(), a = await simulator().beginAttempt(begin(f.intent));
  await observe(a, "refused");
  const next = await simulator().beginAttempt({ ...begin(f.intent), methodFacts: a.methodFacts, at: "2026-10-30T13:00:00.000Z" });
  expect(next.methodFacts).toEqual(a.methodFacts);
  expect(next.settlementChannelKey).toBe("sandbox");
  expect(next.dispatchedAt).not.toBe(a.dispatchedAt);
  expect(next.methodFacts.unattendedChargeAuthorizedAt).toBe(a.methodFacts.unattendedChargeAuthorizedAt);
});

for (const outcome of ["refused", "captured"] as const) it(`closes older unknown truth on ${outcome} without a stuck reclaim obligation`, async () => {
  const f = await fixture(), input = begin(f.intent), a = await simulator().beginAttempt(input);
  const unknown = await observe(a, "indeterminate"); expect((await receive(a, unknown.id)).status).toBe(200);
  const original = await eventFor(unknown.id), terminal = await observe(a, outcome);
  if (outcome === "refused") await expect(simulator().beginAttempt(begin(f.intent))).rejects.toThrow("payment_simulator_truth_unresolved");
  expect((await receive(a, terminal.id)).status).toBe(200);
  expect(await truth().readEvent(original.id)).toMatchObject({ event: { state: "settled", outcome } });
  expect((await truth().sweepOpenEvents({ now: "2030-01-01T00:00:00Z", limit: 1000 })).eventIds).not.toContain(original.id);
  if (outcome === "refused") expect((await simulator().beginAttempt(begin(f.intent))).id).not.toBe(a.id);
  const replay = await restart({ identity: { settlementIntentId: f.intent, attemptId: a.id }, begin: input, delivery: delivery(a, unknown.id) });
  expect(replay.response).toMatchObject({ status: 200, data: { replayed: true } });
  expect((await admin.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome=$2", [f.intent, outcome === "captured" ? "succeeded" : "failed"])).rows).toHaveLength(1);
});
