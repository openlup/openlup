// Disposable PG16 production-path qualification for the explicit restricted generation.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, Pool, type PoolClient, type PoolConfig } from "pg";
import { createPostgresDataGateway, type PgGatewayClient } from "@openlup/platform/data";
import { advisoryLockKey, createPgAdvisoryLock, withAdvisoryLock, type AdvisoryLockQuerier } from "@openlup/platform/scheduler";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresCatalogPayload, qualifiedAdminPostgresStartupOptions,
  type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { runReleasedSchemaUpgradeProof } from "./m14ReleasedSchemaUpgrade.proof.js";

const lockName = "openlup:public-platform-migrations:v1";
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const identifier = (name: string): string => { assert.match(name, /^[a-z_][a-z0-9_]*$/u); return `"${name}"`; };

export async function runQualifiedAdminCompositionProof(input: { roleMode: "installer-managed" | "operator-provisioned"; inventory: string; database?: PoolConfig;
 trustedControlPlane?: { roleNames: readonly string[] }; target?: "rds"; layout?: "serial-cluster";
 rolePrefix?: string; schemaProof?: { previousApplicationPath: string } }) {
 const pools: Pool[] = [];
 let container;
 try {
  const password = randomBytes(24).toString("hex");
  container = input.database ? { connectionString: input.database.connectionString!, remove: async () => {} } : await runPostgresContainer({ name: `m14-qb-production-${input.roleMode}-${process.pid}`, password: "synthetic-conformance" });
  if (!input.database) assert.equal(await waitForPostgresTcpReady(container.connectionString), true);
  const bootstrapLogin = decodeURIComponent(new URL(container.connectionString).username);
  const databaseName = decodeURIComponent(new URL(container.connectionString).pathname.slice(1));
  const pool = (url: string): Pool => { const value = new Pool({ ...input.database, connectionString: url }); pools.push(value); return value; };
  const loginUrl = (name: string): string => { const value = new URL(container!.connectionString); value.username = name;
    value.password = name === bootstrapLogin ? new URL(container!.connectionString).password : password; return value.toString(); };
  const bootstrap = pool(container.connectionString);
  const prefix = input.rolePrefix ?? (input.roleMode === "installer-managed" ? "qb_proof_managed" : "qb_proof_operator");
  const m = `${prefix}_m`, r = `${prefix}_r`, s = `${prefix}_s`, o = `${prefix}_o`;
  await bootstrap.query(`CREATE ROLE ${identifier(m)} LOGIN NOINHERIT ${input.roleMode === "installer-managed" ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await bootstrap.query(`ALTER DATABASE ${identifier(databaseName)} OWNER TO ${identifier(m)}`);
  for (const role of [r, s]) await bootstrap.query(`CREATE ROLE ${identifier(role)} LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  if (input.roleMode === "operator-provisioned") {
    await bootstrap.query(`CREATE ROLE ${identifier(o)} LOGIN NOINHERIT CREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    const operator = pool(loginUrl(o));
    for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
      await bootstrap.query(`CREATE ROLE ${identifier(group)} NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS`);
      await bootstrap.query(`GRANT ${identifier(group)} TO ${identifier(o)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
      await operator.query(`GRANT ${identifier(group)} TO ${identifier(m)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${identifier(o)}`);
      if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group))
        await operator.query(`GRANT ${identifier(group)} TO ${identifier(r)} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${identifier(o)}`);
    }
  }
  const selection: QualifiedAdminPostgresInstallation = input.roleMode === "installer-managed"
    ? { generation: "qualified-admin", roleMode: input.roleMode, migrationLogin: m, bootstrapLogin, runtimeLogin: r, restoreLogin: s }
    : { generation: "qualified-admin", roleMode: input.roleMode, migrationLogin: m, bootstrapLogin, runtimeLogin: r, restoreLogin: s, operatorLogin: o };
  if (input.trustedControlPlane) selection.trustedControlPlane = input.trustedControlPlane;
  if (input.target !== undefined) { selection.target = input.target; selection.layout = input.layout; }
  const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as PlatformMigrationManifest,
    "qualified-admin", { roleMode: input.roleMode });
  assert.equal(manifest.objectInventorySha256, input.inventory);
  const expected = [manifest.baseline, ...manifest.forward];
  assert.equal(expected.length, 92);
  for (const entry of expected) assert.equal(hash(readFileSync(entry.file, "utf8")), entry.sha256);
  const migrationUrl = new URL(loginUrl(m));
  migrationUrl.searchParams.set("options", qualifiedAdminPostgresStartupOptions(selection));
  const migrationPool = pool(migrationUrl.toString());
  const makeRunner = (factory: () => Pool = () => migrationPool) => createPostgresMigrationRunner({ connectionString: loginUrl(m) },
    { installation: selection, poolFactory: async () => factory() });
  const runner = makeRunner();
  if (input.schemaProof) return await runReleasedSchemaUpgradeProof({ database: { ...input.database,
    connectionString: loginUrl(m), options: qualifiedAdminPostgresStartupOptions(selection) }, installation: selection,
    previousApplicationPath: input.schemaProof.previousApplicationPath, requirePreviousApplication: true, rolePrefix: prefix });
  const before = await runner.status();
  assert.deepEqual(before, { applied: [], pending: expected.map(entry => entry.file) });
  assert.deepEqual((await migrationPool.query("SELECT current_user,session_user")).rows, [{ current_user: m, session_user: m }]);
  const roleFacts = (await migrationPool.query("SELECT rolsuper,rolcreaterole FROM pg_catalog.pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(roleFacts, { rolsuper: false, rolcreaterole: input.roleMode === "installer-managed" });
  let begins = 0;
  const interruptingPool = { connect: async () => {
    const actual = await migrationPool.connect();
    return { query: (text: string, values?: unknown[]) => {
      if (text === "BEGIN" && ++begins === 18) throw new Error("synthetic interruption before unit 18");
      return actual.query(text, values);
    }, release: (error?: Error) => actual.release(error) } as unknown as PoolClient;
  } } as Pool;
  await assert.rejects(makeRunner(() => interruptingPool).apply(), /synthetic interruption before unit 18/u);
  const prefixStatus = await runner.status();
  assert.equal(prefixStatus.applied.length, 17);
  assert.equal(prefixStatus.pending.length, 75);
  const resumed = await runner.apply();
  assert.equal(resumed.applied.length, 75);
  const installed = (await bootstrap.query("SELECT catalog_path,sha256,position,executed_at::pg_catalog.text FROM ONLY public.platform_schema_migrations ORDER BY position")).rows;
  assert.deepEqual(installed.map(({ executed_at: _time, ...row }) => row), expected.map((entry, position) => ({ catalog_path: entry.file, sha256: entry.sha256, position })));
  assert.deepEqual(await runner.status(), { applied: expected.map(entry => entry.file), pending: [] });
  assert.deepEqual(await runner.apply(), { applied: [] });
  const switchedUrl = new URL(loginUrl(bootstrapLogin));
  switchedUrl.searchParams.set("options", qualifiedAdminPostgresStartupOptions(selection));
  const switchedSession = pool(switchedUrl.toString());
  await switchedSession.query(`SET ROLE ${identifier(m)}`);
  try { await assert.rejects(makeRunner(() => switchedSession).status(), /actual_login_or_owner_mismatch/u); }
  finally { await switchedSession.query("RESET ROLE"); }
  const observer = await migrationPool.connect();
  let inventory: string;
  try {
    await observer.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lockName]);
    inventory = hash(await qualifiedAdminPostgresCatalogPayload(observer, selection, lockName));
    assert.equal(inventory, input.inventory);
  } finally { await observer.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))", [lockName]); observer.release(); }

  // The trusted migrator retains fixed ADMIN edges; runtime and restore cannot create objects.
  const edges = (await bootstrap.query(`SELECT role.rolname AS granted, member.rolname AS member, a.admin_option
    FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles role ON role.oid=a.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=a.member WHERE member.rolname=$1 ORDER BY granted`, [m])).rows;
  assert.deepEqual(edges.map(row => [row.granted, row.admin_option]),
    ["anon", "authenticated", "openlup_retained_import_owner", "platform_acquisition_owner", "platform_acquisition_runtime", "service_role"].sort().map(name => [name, true]));
  const runtime = pool(loginUrl(r)), restore = pool(loginUrl(s));
  for (const [actor, name] of [[runtime, r], [restore, s]] as const) {
    assert.deepEqual((await actor.query("SELECT current_user,session_user")).rows, [{ current_user: name, session_user: name }]);
    await assert.rejects(actor.query("CREATE TABLE public.forbidden_qualified_object(id integer)"), { code: "42501" });
    await assert.rejects(actor.query("SET session_replication_role=replica"), { code: "42501" });
  }
  const clientId = (await runtime.query("INSERT INTO public.clients(email,lifecycle_stage) VALUES($1,'lead') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0].id;
  await runtime.query("UPDATE public.clients SET first_name='runtime' WHERE id=$1", [clientId]);
  assert.equal((await runtime.query("SELECT first_name FROM public.clients WHERE id=$1", [clientId])).rows[0].first_name, "runtime");
  await assert.rejects(runtime.query("UPDATE public.platform_schema_migrations SET position=99 WHERE position=0"), { code: "42501" });
  await assert.rejects(restore.query("UPDATE public.clients SET first_name='restore' WHERE id=$1", [clientId]), { code: "42501" });
  const actor = await runtime.connect();
  const principal = randomUUID();
  await runtime.query("UPDATE public.clients SET principal_id=$1 WHERE id=$2", [principal, clientId]);
  try {
    await actor.query("BEGIN");
    await actor.query("SET LOCAL ROLE authenticated");
    await actor.query("SELECT pg_catalog.set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: randomUUID() })]);
    assert.deepEqual((await actor.query("SELECT id FROM public.clients WHERE id=$1", [clientId])).rows, []);
    await actor.query("SELECT pg_catalog.set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal })]);
    assert.deepEqual((await actor.query("SELECT id FROM public.clients WHERE id=$1", [clientId])).rows, [{ id: clientId }]);
  } finally { await actor.query("ROLLBACK"); actor.release(); }
  const anonymous = await runtime.connect();
  try {
    await anonymous.query("BEGIN");
    await anonymous.query("SET LOCAL ROLE anon");
    await assert.rejects(anonymous.query("SELECT id FROM public.clients"), { code: "42501" });
  } finally { await anonymous.query("ROLLBACK"); anonymous.release(); }
  const restored = await restore.connect();
  try {
    await restored.query("BEGIN");
    assert.equal((await restored.query(`SELECT public.client_import_retained_row(
      $1::pg_catalog.uuid,'2020-01-02'::pg_catalog.timestamptz,'2020-01-03'::pg_catalog.timestamptz,
      $2::pg_catalog.text,NULL,NULL,NULL,NULL,'customer',NULL,NULL,'{}'::pg_catalog.jsonb,NULL::pg_catalog.uuid) AS inserted`,
    [randomUUID(), `${randomUUID()}@example.invalid`])).rows[0].inserted, true);
  } finally { await restored.query("ROLLBACK"); restored.release(); }

  // Reuse the live connection recipe: pooled request work, direct M runner,
  // optional read-only R session, and dedicated R session advisory locking.
  const gateway = createPostgresDataGateway({ connectionString: loginUrl(r) }, { poolFactory: () => runtime });
  const request = await gateway.asService(async raw => (raw as PgGatewayClient).from("clients").select("id").limit(1));
  assert.equal(request.error, null);
  assert.ok(request.data?.length);
  const readonly = await runtime.connect();
  try { await readonly.query("BEGIN READ ONLY");
    assert.ok((await readonly.query("SELECT id FROM public.clients LIMIT 1")).rowCount);
    await assert.rejects(readonly.query("INSERT INTO public.clients(email) VALUES('read-only@example.invalid')"), { code: "25006" });
  } finally { await readonly.query("ROLLBACK"); readonly.release(); }
  const first = new Client({ ...input.database, connectionString: loginUrl(r) }), second = new Client({ ...input.database, connectionString: loginUrl(r) });
  await first.connect(); await second.connect();
  try {
    assert.notEqual((await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const owner = createPgAdvisoryLock(first as unknown as AdvisoryLockQuerier);
    const competitor = createPgAdvisoryLock(second as unknown as AdvisoryLockQuerier);
    let runs = 0;
    await withAdvisoryLock("qualified-admin-scheduler", owner, async () => { runs++; await first.query("SELECT 1");
      assert.equal(await competitor.tryAcquire("qualified-admin-scheduler"), false); }, (_id, error) => { throw error; })();
    assert.equal(runs, 1);
    assert.equal(await competitor.tryAcquire("qualified-admin-scheduler"), true);
    await competitor.release("qualified-admin-scheduler");
    let calls = 0;
    const switched = createPgAdvisoryLock({ query: <T>(sql: string, values?: unknown[]) => {
      calls++;
      return (calls > 1 ? second : first as unknown as AdvisoryLockQuerier).query<T>(sql, values);
    } });
    await assert.rejects(withAdvisoryLock("qualified-admin-scheduler", switched, async () => { runs++; },
      (_id, error) => { throw error; }), /OPENLUP_E_ADVISORY_SESSION_AFFINITY.*never transaction pooling/u);
    assert.equal(runs, 1);
    await first.query("SELECT pg_advisory_unlock_all()");
  } finally { await Promise.all([first.end(), second.end()]); }

  // F5-equivalent owner-body and namespace shadows on this selected generation.
  const owners = (await bootstrap.query(`SELECT n.nspname,p.proname,p.proconfig FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname,p.proname) IN
    (('acquisition_private','keyed_digest'),('acquisition_private','case_projection'),
     ('acquisition_private','refuse_append_only_mutation'),('public','acquisition_case_submit_v1'),
     ('public','acquisition_case_operator_list_v1'),('public','acquisition_case_transition_v1'),
     ('public','acquisition_case_active_count_v1'),('public','customer_subject_capture_lifecycle'),
     ('public','subscription_delivery_alignment_guard_cycle_insert')) ORDER BY n.nspname,p.proname`)).rows;
  assert.equal(owners.length, 9);
  for (const row of owners) assert.deepEqual(row.proconfig, ["search_path=pg_catalog, pg_temp"]);
  const shadow = await runtime.connect();
  try {
    await shadow.query(`CREATE TEMP TABLE cases(marker pg_catalog.text);
      CREATE FUNCTION pg_temp.owner_path_marker() RETURNS pg_catalog.bool LANGUAGE plpgsql VOLATILE AS $$
        BEGIN RAISE EXCEPTION 'shadow invoked' USING ERRCODE='P0001'; END $$;
      CREATE DOMAIN pg_temp.uuid AS pg_catalog.uuid CHECK (pg_temp.owner_path_marker());
      CREATE FUNCTION pg_temp.now() RETURNS pg_catalog.timestamptz LANGUAGE plpgsql VOLATILE AS $$
        BEGIN PERFORM pg_temp.owner_path_marker(); RETURN pg_catalog.now(); END $$;`);
    for (const sql of [
      "SELECT public.acquisition_case_submit_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
      "SELECT public.acquisition_case_operator_list_v1(NULL,NULL,NULL,3)",
      "SELECT public.acquisition_case_transition_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
    ]) {
      await shadow.query("BEGIN");
      try { await shadow.query("SET LOCAL ROLE platform_acquisition_runtime");
        await assert.rejects(shadow.query(sql), { code: "22023" });
      } finally { await shadow.query("ROLLBACK"); }
    }
    await shadow.query("BEGIN");
    try { await shadow.query("SET LOCAL ROLE platform_acquisition_runtime");
      assert.equal(typeof (await shadow.query("SELECT public.acquisition_case_active_count_v1() AS count")).rows[0].count, "string");
    } finally { await shadow.query("ROLLBACK"); }
  } finally { shadow.release(); }
  const privateShadow = await bootstrap.connect();
  try {
    await privateShadow.query(`SET ROLE ${identifier(r)}`);
    await privateShadow.query(`CREATE FUNCTION pg_temp.owner_path_marker() RETURNS pg_catalog.bool LANGUAGE plpgsql VOLATILE AS $$
      BEGIN RAISE EXCEPTION 'shadow invoked' USING ERRCODE='P0001'; END $$;
      CREATE DOMAIN pg_temp.uuid AS pg_catalog.uuid CHECK (pg_temp.owner_path_marker());`);
    await privateShadow.query("RESET ROLE");
    await privateShadow.query("BEGIN");
    try { await privateShadow.query("SET LOCAL ROLE platform_acquisition_owner");
      assert.equal((await privateShadow.query("SELECT acquisition_private.keyed_digest('owner-path','{}'::pg_catalog.jsonb) AS value")).rows[0].value.length, 32);
      assert.deepEqual((await privateShadow.query("SELECT acquisition_private.case_projection($1::pg_catalog.uuid) AS value", [randomUUID()])).rows, [{ value: null }]);
      await assert.rejects(privateShadow.query("TRUNCATE acquisition_private.commands"), { code: "42501", message: "acquisition_append_only" });
    } finally { await privateShadow.query("ROLLBACK"); }
  } finally { privateShadow.release(); }
  const restoredShadow = await restore.connect();
  try {
    await restoredShadow.query(`CREATE FUNCTION pg_temp.owner_path_marker() RETURNS pg_catalog.bool LANGUAGE plpgsql VOLATILE AS $$
      BEGIN RAISE EXCEPTION 'shadow invoked' USING ERRCODE='P0001'; END $$;
      CREATE DOMAIN pg_temp.uuid AS pg_catalog.uuid CHECK (pg_temp.owner_path_marker());`);
    await restoredShadow.query("BEGIN");
    try { await restoredShadow.query(`SELECT public.client_import_retained_row(
      $1::pg_catalog.uuid,'2020-01-02'::pg_catalog.timestamptz,'2020-01-03'::pg_catalog.timestamptz,
      $2::pg_catalog.text,NULL,NULL,NULL,NULL,'customer',NULL,NULL,'{}'::pg_catalog.jsonb,NULL::pg_catalog.uuid)`,
    [randomUUID(), `${randomUUID()}@example.invalid`]); }
    finally { await restoredShadow.query("ROLLBACK"); }
  } finally { restoredShadow.release(); }
  await bootstrap.query(`CREATE TABLE public.qb_shadow_calls(kind pg_catalog.text NOT NULL);
    CREATE FUNCTION public.left(value pg_catalog.name,size pg_catalog.int4) RETURNS pg_catalog.text LANGUAGE plpgsql VOLATILE AS $$
      BEGIN INSERT INTO public.qb_shadow_calls VALUES ('left'); RETURN pg_catalog.left(value::pg_catalog.text,size); END $$;
    CREATE FUNCTION public.hashtextextended(value pg_catalog.text,seed pg_catalog.int4) RETURNS pg_catalog.int8 LANGUAGE plpgsql VOLATILE AS $$
      BEGIN INSERT INTO public.qb_shadow_calls VALUES ('hashtextextended'); RETURN pg_catalog.hashtextextended(value,seed::pg_catalog.int8); END $$;`);
  try {
    await assert.rejects(runner.status(), /object inventory SHA-256 mismatch/u);
    await assert.rejects(runner.apply({ dryRun: true }), /object inventory SHA-256 mismatch/u);
    await assert.rejects(runner.apply(), /object inventory SHA-256 mismatch/u);
    assert.deepEqual((await bootstrap.query("SELECT kind FROM public.qb_shadow_calls")).rows, []);
  } finally { await bootstrap.query(`DROP FUNCTION public.left(pg_catalog.name,pg_catalog.int4);
    DROP FUNCTION public.hashtextextended(pg_catalog.text,pg_catalog.int4); DROP TABLE public.qb_shadow_calls`); }
  const originalComment = (await bootstrap.query("SELECT pg_catalog.col_description('public.clients'::pg_catalog.regclass,attnum) AS comment FROM pg_catalog.pg_attribute WHERE attrelid='public.clients'::pg_catalog.regclass AND attname='email'")).rows[0].comment;
  await bootstrap.query("COMMENT ON COLUMN public.clients.email IS 'inventory mutation fixture'");
  try { await assert.rejects(runner.status(), /object inventory SHA-256 mismatch/u); }
  finally { const sql = (await bootstrap.query("SELECT pg_catalog.format('COMMENT ON COLUMN public.clients.email IS %L',$1::pg_catalog.text) AS sql", [originalComment])).rows[0].sql;
    await bootstrap.query(sql); }
  await bootstrap.query("GRANT SET ON PARAMETER session_replication_role TO anon");
  try { await assert.rejects(runner.status(), /runtime_persistent_ddl_or_replication_unsafe/u); }
  finally { await bootstrap.query("REVOKE SET ON PARAMETER session_replication_role FROM anon"); }
  await bootstrap.query(`ALTER ROLE ${identifier(m)} IN DATABASE ${identifier(databaseName)} SET search_path TO public, pg_catalog`);
  const alteredPool = pool(migrationUrl.toString());
  try {
    const altered = makeRunner(() => alteredPool);
    await assert.rejects(altered.status(), /canonical_search_path_required/u);
  } finally { await alteredPool.end(); pools.splice(pools.indexOf(alteredPool), 1);
    await bootstrap.query(`ALTER ROLE ${identifier(m)} IN DATABASE ${identifier(databaseName)} RESET search_path`); }
  const outsider = `${prefix}_outsider`;
  await bootstrap.query(`CREATE ROLE ${identifier(outsider)} NOLOGIN NOCREATEROLE NOSUPERUSER`);
  await bootstrap.query(`GRANT service_role TO ${identifier(outsider)} WITH ADMIN FALSE, INHERIT FALSE, SET FALSE`);
  try { await assert.rejects(runner.status(), /protected_membership_graph_differs/u); }
  finally { await bootstrap.query(`REVOKE service_role FROM ${identifier(outsider)}`); await bootstrap.query(`DROP ROLE ${identifier(outsider)}`); }
  assert.deepEqual(await runner.status(), { applied: expected.map(entry => entry.file), pending: [] });
  assert.deepEqual(await runner.apply(), { applied: [] });
  const finalLedger = (await bootstrap.query("SELECT catalog_path,sha256,position,executed_at::pg_catalog.text FROM ONLY public.platform_schema_migrations ORDER BY position")).rows;
  assert.deepEqual(finalLedger, installed);
  return { identities: { migration: m, runtime: r, restore: s, bootstrap: bootstrapLogin, operator: input.roleMode === "operator-provisioned" ? o : null }, mode: input.roleMode, inventory, pendingBefore: before.pending.length, interruptedPrefix: prefixStatus.applied.length,
    appliedAfterResume: resumed.applied.length, ledgerRows: installed.length, replayApplied: 0,
    runtimeProved: true, restoreProved: true, connectionRecipeProved: true,
    shadowMatrixProved: true, refusalsProved: true };
 } finally { await closePostgres(container, pools); }
}
