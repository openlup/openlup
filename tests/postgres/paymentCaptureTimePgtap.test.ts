import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPaymentWebhookControlPort } from "@openlup/platform/payments";
import { readPlatformMigrationManifest, sha256, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { call } from "./subscriptionNativeFixture.js";

const reader = "public.payment_read_capture_time(uuid,uuid)";
const scope = "public.payment_capture_time_test_qualification";
const provider = "fixture-card";
const account = "fixture-account";
const migration = "_payment_capture_time_read.sql";
const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
const setup = readFileSync("tests/postgres/fixtures/paymentProvider/setup.sql", "utf8");
const tap = readFileSync("tests/postgres/fixtures/paymentCaptureTime/replayed.sql", "utf8");
const options = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };

async function subject(owner: PoolClient) {
  const client = randomUUID(), order = randomUUID(), remote = `pi_${order}`;
  await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await owner.query("SELECT pg_temp.provider_order($1,$2,200)", [order, client]);
  const { rows: [{ at, received }] } = await owner.query(`SELECT
    to_char(t,'YYYY-MM-DD"T"HH24:MI:SS"Z"') at,
    to_char(t+interval '2 seconds','YYYY-MM-DD"T"HH24:MI:SS"Z"') received
    FROM (SELECT date_trunc('second',now() AT TIME ZONE 'UTC')-interval '1 hour' t) clock`);
  const { paymentIntent: { id: intent } } = await call(owner, "payment_provider_intent_create",
    [`intent:${order}`, "one_time_order", order, null, null, 200, "XXX", {}, provider, at]);
  const { paymentAttempt: { id: attempt } } = await call(owner, "payment_provider_attempt_prepare",
    [`prepare:${order}`, intent, provider, `provider:${order}`, "a".repeat(64), "one_time_payment", null, {}]);
  await call(owner, "payment_provider_attempt_finalize",
    [`finalize:${order}`, intent, attempt, `provider:${order}`, "a".repeat(64), remote, null, "processing", null, {}, {}]);
  return { order, intent, attempt, remote, at, received };
}

describe("capture-time forward replay", () => {
  const slot = manifest.forward.findIndex(unit => unit.file.endsWith(migration));
  const candidate = manifest.forward[slot];
  if (!candidate) throw new Error("Capture-time forward missing from the platform migration manifest");
  let container: PostgresContainer | undefined, pool: Pool | undefined;
  beforeAll(async () => {
    expect(manifest.forward[slot - 1]?.file).toMatch(/^db\/platform\/migrations\//u);
    container = await runManagedCompatPostgres({ name: `capture-time-pgtap-${process.pid}`, password: "synthetic-conformance" });
    const url = new URL(container.connectionString);
    url.username = "supabase_admin";
    const bootstrap = new Pool({ connectionString: url.toString() });
    try {
      await bootstrap.query(`DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE;
        DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role`);
      await bootstrap.query("CREATE DATABASE capture_time_replay WITH TEMPLATE template0");
    } finally { await bootstrap.end(); }
    url.pathname = "/capture_time_replay";
    pool = new Pool({ connectionString: url.toString() });
    await pool.query("CREATE SCHEMA extensions; CREATE EXTENSION pgtap WITH SCHEMA extensions");
    for (const unit of [manifest.baseline, ...manifest.forward.slice(0, slot)]) {
      const text = readFileSync(unit.file, "utf8");
      expect(sha256(text)).toBe(unit.sha256);
      await pool.query(text);
    }
  }, postgresSetupTimeoutMs);
  afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

  it.each([true, false])("replays over incumbent rows with optional roles present=%s", async present => {
    const db = await pool!.connect();
    try {
      await db.query("BEGIN; SET LOCAL search_path=public,extensions");
      await db.query(setup);
      const f = await subject(db);
      if (!present) await db.query("DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
      const roles = present ? "PUBLIC,anon,authenticated,service_role" : "PUBLIC";
      await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${roles};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${roles}`);
      const grants = () => db.query(`SELECT 'table' AS kind,c.relname AS name,c.relacl::text AS acl
        FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND c.oid<>coalesce(to_regclass($1),0)
        UNION ALL SELECT 'column',c.relname||'.'||a.attname,a.attacl::text FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL
        UNION ALL SELECT 'routine',p.oid::regprocedure::text,p.proacl::text FROM pg_proc p
        WHERE p.pronamespace='public'::regnamespace AND p.oid<>coalesce(to_regprocedure($2),0)
        ORDER BY 1,2`, [scope, reader]).then(result => result.rows);
      const before = await grants();
      const path = candidate.file;
      const sql = readFileSync(path, "utf8");
      expect(sha256(sql)).toBe(candidate.sha256);
      expect(readFileSync(path.replace("db/platform/migrations/", "packages/platform/sql/"), "utf8")).toBe(sql);
      await db.query(sql);
      expect(await grants()).toEqual(before);
      const results = await db.query(tap);
      const lines = (Array.isArray(results) ? results : [results]).flatMap(result =>
        result.rows.flatMap(row => Object.values<string>(row)));
      expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
      expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(11);
      expect((await db.query("SELECT kind FROM public.payment_read_capture_time($1,NULL)", [f.order])).rows)
        .toEqual([{ kind: "pending" }]);
    } finally { await db.query("ROLLBACK"); db.release(); }
  }, postgresSetupTimeoutMs);
});

for (const profile of ["qualified-v2", "qualified-admin"] as const) describe(`installed owner and runtime on ${profile}`, () => {
  let env: LifecycleInstallation;
  beforeAll(async () => { env = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { await env?.close(); }, postgresTeardownTimeoutMs);

  it("reads an applied capture through a same-owner definer in a later runtime transaction", async () => {
    const migrationOwner = await env.migration.connect();
    const runtime = await env.runtime.connect();
    try {
      const owners = (await migrationOwner.query(`SELECT current_user AS owner,
        (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid=to_regprocedure($1)) AS reader,
        (SELECT array_agg(DISTINCT pg_get_userbyid(c.relowner)::text) FROM pg_class c
          WHERE c.oid=ANY(ARRAY[to_regclass($2),'public.payment_provider_attempt_evidence'::regclass,
            'public.payment_provider_reconciliation_runs'::regclass,'public.payment_truth_events'::regclass,
            'public.commerce_settlement_transitions'::regclass,'public.commerce_settlement_intents'::regclass])) AS relations`,
      [reader, scope])).rows[0];
      expect(owners).toEqual({ owner: owners.owner, reader: owners.owner, relations: [owners.owner] });
      await migrationOwner.query(`CREATE FUNCTION public.fixture_read_capture_time(p_order uuid) RETURNS jsonb
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
        AS 'SELECT to_jsonb(p) FROM public.payment_read_capture_time(p_order,NULL) p';
        REVOKE ALL ON FUNCTION public.fixture_read_capture_time(uuid) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION public.fixture_read_capture_time(uuid) TO service_role`);
      await migrationOwner.query(setup);
      const f = await subject(migrationOwner);
      await runtime.query("SET ROLE NONE");
      expect((await runtime.query(`SELECT current_user=session_user AS login,rolsuper,
        pg_has_role(current_user,'service_role','USAGE') AS inherited FROM pg_roles WHERE rolname=session_user`)).rows)
        .toEqual([{ login: true, rolsuper: false, inherited: true }]);
      const read = (order = f.order) => runtime.query("SELECT public.fixture_read_capture_time($1) AS capture", [order]).then(r => r.rows[0].capture);
      await expect(runtime.query("SELECT * FROM public.payment_read_capture_time($1,NULL)", [f.order])).rejects.toMatchObject({ code: "42501" });
      expect(await read()).toMatchObject({ kind: "pending", code: "capture_time_pending_application" });

      // The incumbent trusted runtime may supply ingress provenance in the
      // test installation. The owner attestation and signed mode are both required.
      const webhook = createPostgresPaymentWebhookControlPort(runtime, options);
      const ingest = (target: Awaited<ReturnType<typeof subject>>, livemode: boolean) => webhook.ingestPaymentEvent({
        provider, providerEventId: `fixture:${target.intent}`, providerPaymentId: target.remote,
        paymentIntentId: target.intent, paymentAttemptId: target.attempt, eventType: "payment.succeeded",
        amountMinor: 200, currency: "XXX", occurredAt: target.at, capturedAmountBasis: "provider_capture_v1",
        rawPayload: {
          captureTimeBasis: "signed_event_v1", livemode, providerAccountRef: account,
          openlupEvidence: { providerOccurredAt: target.at }, openlupReceipt: { receivedAt: target.received },
        },
      });
      const apply = (target: Awaited<ReturnType<typeof subject>>, eventId: string) => webhook.applyPaymentResult!({
        idempotencyKey: `apply:${target.intent}`, paymentIntentId: target.intent, paymentEventId: eventId,
        resultStatus: "succeeded", occurredAt: target.at, failureReason: null,
      });
      const event = await ingest(f, false);
      expect(await read()).toMatchObject({ kind: "pending" });
      await apply(f, event.paymentEventId);
      expect(await read()).toMatchObject({
        kind: "unqualified", code: "capture_time_route_unqualified", payment_mode: "test", captured_at: null,
      });
      for (const sql of [`SELECT * FROM ${scope}`, `INSERT INTO ${scope} VALUES (true,now(),'fixture-card','signed_webhook','fixture-account')`,
        `UPDATE ${scope} SET provider_ref='another-provider',source_path='reconciliation_read',provider_account_ref='another-account'`,
        `DELETE FROM ${scope}`]) {
        await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
      }
      await migrationOwner.query(`INSERT INTO ${scope} (singleton,qualified_at,provider_ref,source_path,provider_account_ref)
        VALUES (true,now(),$1,'signed_webhook','another-account')`, [provider]);
      expect(await read()).toMatchObject({ kind: "unqualified", code: "capture_time_route_unqualified", payment_mode: "test", captured_at: null });
      await migrationOwner.query(`UPDATE ${scope} SET provider_account_ref=$1`, [account]);
      expect(await read()).toMatchObject({
        kind: "authoritative", code: null, payment_mode: "test", evidence_id: event.paymentEventId,
      });
      const live = await subject(migrationOwner);
      const liveEvent = await ingest(live, true);
      await apply(live, liveEvent.paymentEventId);
      expect(await read(live.order)).toMatchObject({ kind: "unqualified", payment_mode: "live", captured_at: null });
      await migrationOwner.query(`DELETE FROM ${scope}`);
      expect(await read()).toMatchObject({ kind: "unqualified", captured_at: null });
    } finally { runtime.release(); migrationOwner.release(); }
  });
});
