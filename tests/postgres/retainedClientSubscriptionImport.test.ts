import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixture, openCase } from "../helpers/fulfillmentNative.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

// This domain-unit witness uses the complete canonical predecessor plus the fixed
// qualified unit and the declared pre-provisioned roles. It does not qualify E's
// selected-generation installer or its ordinary runtime grant surface.
const unit = readFileSync("db/platform/migrations/q2_20261026140000_retained_client_subscription_import.sql", "utf8");
let container: PostgresContainer | undefined;
let prefixRoot: string | undefined;
let pool: Pool;
let restore: Pool;
let runtime: Pool;
const h = { get pool() { return pool; } };
const startup = "SELECT set_config('openlup.qualified.restore_login','m14_restore',true),set_config('openlup.qualified.runtime_login','m14_runtime',true),set_config('openlup.qualified.role_mode','operator-provisioned',true)";

beforeAll(async () => {
  prefixRoot = mkdtempSync(join(tmpdir(), "m14-retained-prefix-"));
  const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
  for (const { file } of [manifest.baseline, ...manifest.forward]) {
    mkdirSync(dirname(join(prefixRoot, file)), { recursive: true });
    copyFileSync(file, join(prefixRoot, file));
  }
  mkdirSync(join(prefixRoot, "config"), { recursive: true });
  writeFileSync(join(prefixRoot, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
  container = await runPostgresContainer({ name: `m14-retained-import-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Retained import requires PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { root: prefixRoot, poolFactory: () => pool }).apply();
  await pool.query(`CREATE ROLE m14_restore LOGIN NOINHERIT PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE m14_runtime LOGIN NOINHERIT PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE openlup_retained_import_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const actor = (name: string) => {
    const url = new URL(container!.connectionString);
    url.username = name; url.password = "synthetic-only";
    return new Pool({ connectionString: url.toString() });
  };
  restore = actor("m14_restore"); runtime = actor("m14_runtime");
  const admission = await pool.connect();
  try {
    for (const [label, change, message] of [
      ["same restore/runtime", "SELECT set_config('openlup.qualified.restore_login','m14_runtime',true)", "login_binding_invalid"],
      ["restore inherited privileges", "ALTER ROLE m14_restore INHERIT", "restore_role_invalid"],
      ["restore membership", "GRANT authenticated TO m14_restore WITH INHERIT FALSE, SET TRUE", "restore_role_invalid"],
      ["owner login", "ALTER ROLE openlup_retained_import_owner LOGIN", "owner_not_sealed"],
      ["runtime can set owner", "GRANT openlup_retained_import_owner TO m14_runtime WITH INHERIT FALSE, SET TRUE", "owner_not_sealed"],
      ["owner DDL", "GRANT CREATE ON SCHEMA public TO openlup_retained_import_owner", "owner_not_sealed"],
      ["owner executable", "CREATE FUNCTION public.unrelated_import_owner_entry() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'; ALTER FUNCTION public.unrelated_import_owner_entry() OWNER TO openlup_retained_import_owner", "owner_not_sealed"],
      ["owner prior table grant", "GRANT SELECT ON public.clients TO openlup_retained_import_owner", "owner_not_sealed"],
      ["owner default grants", "ALTER DEFAULT PRIVILEGES FOR ROLE openlup_retained_import_owner GRANT EXECUTE ON FUNCTIONS TO m14_runtime", "owner_not_sealed"],
    ]) {
      await admission.query("BEGIN");
      try {
        await admission.query(startup); await admission.query(change!);
        await expect(admission.query(unit), label).rejects.toMatchObject({ code: "42501", message: `retained_import_${message}` });
      } finally { await admission.query("ROLLBACK"); }
    }
    await admission.query("BEGIN");
    await admission.query(startup); await admission.query(unit); await admission.query("COMMIT");
  } catch (error) { await admission.query("ROLLBACK"); throw error; }
  finally { admission.release(); }
}, postgresSetupTimeoutMs);

afterAll(async () => {
  try { await closePostgres(container, [pool, restore, runtime]); }
  finally { if (prefixRoot) rmSync(prefixRoot, { recursive: true, force: true }); }
}, postgresTeardownTimeoutMs);

type ClientRow = [string, string, string, string, string | null, string | null, string | null,
  string | null, string, string | null, string | null, string, string | null];
type CycleRow = [string, string, string, string, string, string, string | null, string | null];
const clientSql = "SELECT public.client_import_retained_row($1::uuid,$2::timestamptz,$3::timestamptz,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::jsonb,$13::uuid) AS inserted";
const cycleSql = "SELECT public.subscription_cycle_import_retained_row($1::uuid,$2::uuid,$3::timestamptz,$4::text,$5::timestamptz,$6::timestamptz,$7::uuid,$8::text) AS inserted";
const clientRow = (): ClientRow => {
  const id = randomUUID();
  return [id, "2020-01-02T03:04:05.123456Z", "2021-02-03T04:05:06.654321Z", `${id}@example.invalid`,
    "First distinct", "Last distinct", "+123456789", "fixture-country", "customer", "historical-channel",
    "external-distinct", '{"integer":9007199254740993,"nested":{"a":[null,true,"value"]}}', randomUUID()];
};
const importClient = async (row: ClientRow, db: Pool | PoolClient | Client = restore) =>
  (await db.query<{ inserted: boolean }>(clientSql, row)).rows[0]!.inserted;
const importCycle = async (row: CycleRow, db: Pool | PoolClient | Client = restore) =>
  (await db.query<{ inserted: boolean }>(cycleSql, row)).rows[0]!.inserted;

async function retainedCycle() {
  const f = await fixture(pool);
  const alignment = await openCase(pool, f);
  await pool.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)", [
    `arrival-${f.shipment}`, f.shipment, "2026-09-07T12:00:00.111222Z", `evidence:${f.shipment}`,
  ]);
  const at = (await pool.query("SELECT next_cycle_at::text AS at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].at;
  expect((await pool.query("SELECT public.subscription_delivery_alignment_admit_renewal($1,$2,$3) AS response", [f.subscription, at, "2026-10-21T12:00:00Z"])).rows[0].response)
    .toMatchObject({ allowed: true });
  await pool.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','fixture-stock','fixture-channel','2020-01-02T03:04:05.123456Z','authorization-distinct')`, [f.subscription]);
  await pool.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'fixture-sku',2,9007199254740993)", [f.subscription]);
  const operation = randomUUID();
  await pool.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,claim_token,claim_generation,claimed_by,claimed_at,lease_expires_at)
    VALUES($1,$2,$3,2,$4,$5,'{"amount":9007199254740993}',$6,9007199254740993,'fixture','2026-10-01','2026-11-01')`,
  [operation, f.subscription, at, `subscription:${f.subscription}:cycle:${at}`, "b".repeat(64), randomUUID()]);
  const row: CycleRow = [randomUUID(), f.subscription, at, "payment_pending", "2022-03-04T05:06:07.333444Z", "2023-04-05T06:07:08.555666Z", operation, "b".repeat(64)];
  const snapshot = async () => (await pool.query(`SELECT jsonb_build_object(
    'subscription',(SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=$1),
    'terms',(SELECT to_jsonb(t) FROM public.subscription_renewal_terms t WHERE subscription_id=$1),
    'termLines',(SELECT jsonb_agg(t ORDER BY line_ordinal) FROM public.subscription_renewal_term_lines t WHERE subscription_id=$1),
    'operation',(SELECT to_jsonb(o) FROM public.subscription_renewal_operations o WHERE id=$2),
    'case',(SELECT to_jsonb(c) FROM public.subscription_delivery_alignment_cases c WHERE id=$3),
    'receipts',(SELECT jsonb_agg(r ORDER BY id) FROM public.subscription_delivery_alignment_admission_receipts r WHERE subscription_id=$1))::text AS value`, [f.subscription, operation, alignment.id])).rows[0].value;
  return { row, snapshot };
}

it("ordinary client writes capture creation and each actual lifecycle transition", async () => {
  const id = randomUUID();
  await h.pool.query(`INSERT INTO public.clients(id,email,lifecycle_stage,created_at)
    VALUES($1,$2,'lead','2025-01-02T03:04:05.123456Z')`, [id, `${id}@example.invalid`]);
  const initial = (await h.pool.query(`SELECT from_stage,to_stage,occurred_at::text AS occurred_at
    FROM public.customer_subject_lifecycle_events WHERE client_id=$1`, [id])).rows;
  expect(initial).toEqual([{ from_stage: null, to_stage: "lead", occurred_at: "2025-01-02 03:04:05.123456+00" }]);
  await h.pool.query("UPDATE public.clients SET lifecycle_stage='customer' WHERE id=$1", [id]);
  await h.pool.query("UPDATE public.clients SET lifecycle_stage='customer' WHERE id=$1", [id]);
  expect((await h.pool.query(`SELECT from_stage,to_stage FROM public.customer_subject_lifecycle_events
    WHERE client_id=$1 ORDER BY occurred_at,id`, [id])).rows).toEqual([
    { from_stage: null, to_stage: "lead" }, { from_stage: "lead", to_stage: "customer" },
  ]);
});

it.each(["off", "shadow"])("ordinary cycle creation still releases aligned state in %s mode", async mode => {
  const f = await fixture(h.pool);
  const alignment = await openCase(h.pool, f);
  await h.pool.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)", [
    `arrival-${f.shipment}`, f.shipment, "2026-09-04T12:00:00Z", `evidence:${f.shipment}`,
  ]);
  const before = (await h.pool.query(`SELECT state,aligned_next_cycle_at::text AS at
    FROM public.subscription_delivery_alignment_cases WHERE id=$1`, [alignment.id])).rows[0];
  expect(before.state).toBe("aligned");
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode($1)", [mode]);
  await h.pool.query(`INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)
    VALUES($1,$2,'payment_pending')`, [f.subscription, before.at]);
  expect((await h.pool.query("SELECT state FROM public.subscription_delivery_alignment_cases WHERE id=$1", [alignment.id])).rows)
    .toEqual([{ state: "released" }]);
});

it("ordinary new cycles consume a live admission receipt once", async () => {
  const f = await fixture(h.pool);
  await openCase(h.pool, f);
  await h.pool.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)", [
    `arrival-${f.shipment}`, f.shipment, "2026-09-04T12:00:00Z", `evidence:${f.shipment}`,
  ]);
  const at = (await h.pool.query("SELECT next_cycle_at::text AS at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].at;
  const decision = (await h.pool.query("SELECT public.subscription_delivery_alignment_admit_renewal($1,$2,$3) AS response", [
    f.subscription, at, "2026-10-21T12:00:00Z",
  ])).rows[0].response;
  expect(decision).toMatchObject({ allowed: true });
  const insert = () => h.pool.query(`INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)
    VALUES($1,$2,'payment_pending')`, [f.subscription, at]);
  await insert();
  await expect(insert()).rejects.toThrow("admission_required");
  expect((await h.pool.query(`SELECT consumed_at IS NOT NULL AS consumed
    FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1`, [f.subscription])).rows)
    .toEqual([{ consumed: true }]);
});

it("restore imports every client field exactly without synthesizing or duplicating history", async () => {
  const row = clientRow();
  expect(await importClient(row)).toBe(true);
  expect((await pool.query(`SELECT to_jsonb(c)=jsonb_build_object('id',$1::uuid,'created_at',$2::timestamptz,'updated_at',$3::timestamptz,
    'email',$4::text,'first_name',$5::text,'last_name',$6::text,'phone',$7::text,'country',$8::text,'lifecycle_stage',$9::text,
    'acquisition_source',$10::text,'external_ref',$11::text,'metadata',$12::jsonb,'principal_id',$13::uuid) AS identical
    FROM public.clients c WHERE c.id=$1`, row)).rows).toEqual([{ identical: true }]);
  expect((await pool.query("SELECT id FROM public.customer_subject_lifecycle_events WHERE client_id=$1", [row[0]])).rows).toEqual([]);
  const event = randomUUID();
  await pool.query(`INSERT INTO public.customer_subject_lifecycle_events(id,client_id,from_stage,to_stage,occurred_at)
    VALUES($1,$2,'waitlist','customer','2019-04-05T06:07:08.987654Z')`, [event, row[0]]);
  const before = (await pool.query("SELECT to_jsonb(e)::text AS value FROM public.customer_subject_lifecycle_events e WHERE client_id=$1", [row[0]])).rows;
  expect(await importClient(row)).toBe(false);
  expect((await pool.query("SELECT to_jsonb(e)::text AS value FROM public.customer_subject_lifecycle_events e WHERE client_id=$1", [row[0]])).rows).toEqual(before);
  const changed: ClientRow = [...row]; changed[5] = "different last name";
  await expect(importClient(changed)).rejects.toMatchObject({ code: "23505", message: "client_retained_row_conflict" });
  const nullable = clientRow(); nullable[4] = null; nullable[5] = null; nullable[6] = null;
  nullable[7] = null; nullable[9] = null; nullable[10] = null; nullable[12] = null;
  expect(await importClient(nullable)).toBe(true); expect(await importClient(nullable)).toBe(false);
});

it("restore preserves all cycle fields, frozen terms and live admission state across every mode", async () => {
  const { row, snapshot } = await retainedCycle();
  const before = await snapshot();
  for (const mode of ["off", "shadow", "protect", "auto_align"]) {
    await pool.query("SELECT public.subscription_delivery_alignment_set_mode($1)", [mode]);
    expect(await importCycle(row)).toBe(mode === "off");
    expect(await snapshot()).toBe(before);
  }
  expect((await pool.query(`SELECT to_jsonb(c)=jsonb_build_object('id',$1::uuid,'subscription_id',$2::uuid,'scheduled_at',$3::timestamptz,
    'status',$4::text,'created_at',$5::timestamptz,'updated_at',$6::timestamptz,'renewal_operation_id',$7::uuid,'renewal_operation_fingerprint',$8::text) AS identical
    FROM public.subscription_cycles c WHERE c.id=$1`, row)).rows).toEqual([{ identical: true }]);
  const changed: CycleRow = [...row]; changed[3] = "cancelled";
  await expect(importCycle(changed)).rejects.toMatchObject({ code: "23505", message: "subscription_cycle_retained_row_conflict" });
  expect(await snapshot()).toBe(before);
});

it("historical cycle import retains protected obligations while ordinary creation remains refused", async () => {
  const f = await fixture(pool); const alignment = await openCase(pool, f);
  const row: CycleRow = [randomUUID(), f.subscription, "2026-08-29T12:00:00Z", "payment_pending", "2022-01-02T03:04:05.111222Z", "2023-02-03T04:05:06.333444Z", null, null];
  const before = (await pool.query("SELECT to_jsonb(c)::text AS value FROM public.subscription_delivery_alignment_cases c WHERE id=$1", [alignment.id])).rows;
  expect(await importCycle(row)).toBe(true);
  expect((await pool.query("SELECT to_jsonb(c)::text AS value FROM public.subscription_delivery_alignment_cases c WHERE id=$1", [alignment.id])).rows).toEqual(before);
  await expect(pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')", [f.subscription, row[2]])).rejects.toThrow("alignment_protected");
});

it("a differing cycle rolls back the complete import transaction without consuming receipts", async () => {
  const { row, snapshot } = await retainedCycle();
  await importCycle(row); const before = await snapshot(); const client = clientRow();
  const tx = await restore.connect();
  try {
    await tx.query("BEGIN"); await importClient(client, tx);
    const changed: CycleRow = [...row]; changed[3] = "cancelled";
    await expect(importCycle(changed, tx)).rejects.toMatchObject({ code: "23505" });
    await tx.query("ROLLBACK");
  } finally { await tx.query("ROLLBACK"); tx.release(); }
  expect((await pool.query("SELECT id FROM public.clients WHERE id=$1", [client[0]])).rows).toEqual([]);
  expect(await snapshot()).toBe(before);
});

it("constraints and every target trigger stay enabled for retained imports", async () => {
  const invalid = clientRow(); invalid[3] = "";
  await expect(importClient(invalid)).rejects.toMatchObject({ code: "23514" });
  const absent: CycleRow = [randomUUID(), randomUUID(), "2026-08-29", "payment_pending", "2021-01-01", "2022-01-01", null, null];
  await expect(importCycle(absent)).rejects.toMatchObject({ code: "23503" });
  const f = await fixture(pool); const invalidStatus: CycleRow = [...absent]; invalidStatus[1] = f.subscription; invalidStatus[3] = "unknown";
  await expect(importCycle(invalidStatus)).rejects.toMatchObject({ code: "23514" });
  expect((await pool.query(`SELECT tgname,tgenabled FROM pg_catalog.pg_trigger
    WHERE tgrelid IN ('public.clients'::regclass,'public.subscription_cycles'::regclass) AND NOT tgisinternal ORDER BY tgname`)).rows).toEqual([
    { tgname: "customer_subject_capture_lifecycle_trigger", tgenabled: "O" },
    { tgname: "trg_subscription_delivery_alignment_guard_cycle_insert", tgenabled: "O" },
  ]);
});

it("hostile name resolution and forged settings cannot grant import or owner authority", async () => {
  const hostile = await restore.connect();
  try {
    await hostile.query("CREATE TEMP TABLE clients(id uuid); CREATE TEMP TABLE subscription_cycles(id uuid); SET search_path=pg_temp,public,pg_catalog");
    await hostile.query("SELECT set_config('openlup.retained_import','true',false),set_config('request.jwt.claims','{\"role\":\"openlup_retained_import_owner\"}',false)");
    expect(await importClient(clientRow(), hostile)).toBe(true);
    expect((await hostile.query("SELECT count(*)::int AS n FROM pg_temp.clients")).rows).toEqual([{ n: 0 }]);
    for (const sql of ["SET ROLE openlup_retained_import_owner", "SET SESSION AUTHORIZATION openlup_retained_import_owner",
      "INSERT INTO public.clients(email) VALUES('denied@example.invalid')", "SELECT * FROM public.clients", "CREATE TABLE public.import_escape(id integer)"]) {
      await expect(hostile.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
    expect((await hostile.query("SELECT current_user,session_user")).rows).toEqual([{ current_user: "m14_restore", session_user: "m14_restore" }]);
  } finally {
    await hostile.query("DROP TABLE IF EXISTS pg_temp.clients,pg_temp.subscription_cycles; RESET search_path; RESET openlup.retained_import; RESET request.jwt.claims");
    hostile.release();
  }
  const caller = await runtime.connect();
  try {
    await caller.query("SELECT set_config('openlup.qualified.restore_login','m14_runtime',false),set_config('request.jwt.claims','{\"role\":\"openlup_retained_import_owner\"}',false)");
    await expect(importClient(clientRow(), caller)).rejects.toMatchObject({ code: "42501" });
    await expect(caller.query("SET ROLE openlup_retained_import_owner")).rejects.toMatchObject({ code: "42501" });
    await expect(caller.query(unit)).rejects.toMatchObject({ code: "42501", message: "retained_import_installer_requires_superuser" });
  } finally { await caller.query("RESET openlup.qualified.restore_login; RESET request.jwt.claims"); caller.release(); }
});

it("a terminated restore transaction rolls back, then resumes once with exact replay", async () => {
  const row = clientRow();
  const killed = new Client({ connectionString: restore.options.connectionString });
  const unexpected: Error[] = [];
  killed.on("error", (error: Error & { code?: string }) => {
    if (error.code !== "57P01" && error.message !== "Connection terminated unexpectedly") unexpected.push(error);
  });
  try {
    await killed.connect(); await killed.query("BEGIN"); await importClient(row, killed);
    const pid = (await killed.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await pool.query("SELECT pg_terminate_backend($1)", [pid]); await killed.end();
  } finally { await killed.end(); }
  expect(unexpected).toEqual([]);
  expect((await pool.query("SELECT id FROM public.clients WHERE id=$1", [row[0]])).rows).toEqual([]);
  expect(await importClient(row)).toBe(true); expect(await importClient(row)).toBe(false);
});

it.each(["replica", "local"])("both retained entrypoints refuse a privileged hostile %s session", async mode => {
  const actor = await restore.connect();
  const client = clientRow();
  const cycle: CycleRow = [randomUUID(), randomUUID(), "2026-10-05T12:00:00.111222Z", "payment_pending",
    "2022-03-04T05:06:07.333444Z", "2023-04-05T06:07:08.555666Z", null, null];
  try {
    await expect(actor.query("SET session_replication_role='replica'")).rejects.toMatchObject({ code: "42501" });
    // Fault injection models a later privileged host grant. Product code grants
    // and changes no parameter; both fixed routines must independently refuse.
    await pool.query("GRANT SET ON PARAMETER session_replication_role TO m14_restore");
    for (const invoke of [() => importClient(client, actor), () => importCycle(cycle, actor)]) {
      await actor.query("BEGIN");
      try {
        await actor.query("SELECT pg_catalog.set_config('session_replication_role',$1,true)", [mode]);
        await expect(invoke()).rejects.toMatchObject({ code: "55000", message: "retained_import_requires_origin" });
      } finally { await actor.query("ROLLBACK"); }
    }
    expect((await pool.query("SELECT id FROM public.clients WHERE id=$1", [client[0]])).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM public.subscription_cycles WHERE id=$1", [cycle[0]])).rows).toEqual([]);
    expect((await actor.query("SELECT current_user,pg_catalog.current_setting('session_replication_role') AS mode")).rows)
      .toEqual([{ current_user: "m14_restore", mode: "origin" }]);
  } finally {
    try { await actor.query("ROLLBACK"); }
    finally { actor.release(); await pool.query("REVOKE SET ON PARAMETER session_replication_role FROM m14_restore"); }
  }
});
