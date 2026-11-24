import { captureCompatiblePostgresRows, restoreCompatiblePostgresRows, type CompatiblePostgresTable } from "@openlup/platform/portability";
import { createPostgresSubscriptionCommands } from "@openlup/platform/subscriptions";
import type { SubscriptionCommand } from "@openlup/platform/subscriptions/contracts";
import { createHash, randomUUID } from "node:crypto";
import installationInventory from "./current-installation-inventory.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { expect, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresStartupOptions, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

type Shape = "neon" | "rds";
type Mode = "installer-managed" | "operator-provisioned";
type Installed = { container: PostgresContainer; pools: Pool[]; owner: Pool; runner: ReturnType<typeof createPostgresMigrationRunner>;
  selection: QualifiedAdminPostgresInstallation; inventory: string };
const password = "synthetic-restricted-restore";
const groups = ["anon", "authenticated", "service_role", "platform_acquisition_owner",
  "platform_acquisition_runtime", "openlup_retained_import_owner"];

async function install(shape: Shape, mode: Mode, label: string, apply = true): Promise<Installed> {
  const container = await runPostgresContainer({ name: `m14-restricted-connected-${shape}-${mode}-${label}-${process.pid}`, password });
  const pools: Pool[] = [];
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const pool = (url: string): Pool => { const p = new Pool({ connectionString: url }); pools.push(p); return p; };
    let root = pool(container.connectionString);
    const namedUrl = (name: string): string => { const url = new URL(container.connectionString); url.username = name; return url.toString(); };
    const rootName = shape === "rds" ? "rdsadmin" : "postgres";
    if (shape === "rds") {
      await root.query(`CREATE ROLE fixture_root_rename LOGIN SUPERUSER PASSWORD '${password}'`);
      const renamer = pool(namedUrl("fixture_root_rename"));
      await renamer.query("ALTER ROLE postgres RENAME TO rdsadmin");
      await Promise.all(pools.map(p => p.end())); pools.length = 0;
      root = pool(namedUrl(rootName));
      await root.query("DROP ROLE fixture_root_rename");
    }
    const m = "restore_m", r = "restore_r", s = "restore_s", o = "restore_o";
    const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
    await root.query(`CREATE ROLE ${provider} NOLOGIN NOINHERIT NOSUPERUSER ${shape === "rds" ? "NOCREATEROLE NOCREATEDB" : "CREATEROLE CREATEDB"} NOREPLICATION NOBYPASSRLS`);
    if (shape === "rds") await root.query(`GRANT pg_monitor,pg_read_all_data,pg_write_all_data TO ${provider} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    await root.query(`CREATE ROLE host_bootstrap LOGIN INHERIT NOSUPERUSER CREATEROLE CREATEDB
      ${shape === "neon" ? "REPLICATION" : "NOREPLICATION"} NOBYPASSRLS VALID UNTIL 'infinity' PASSWORD '${password}'`);
    await root.query(`GRANT ${provider} TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    await root.query("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC");
    await root.query(`CREATE ROLE ${m} LOGIN NOINHERIT NOSUPERUSER ${mode === "installer-managed" ? "CREATEROLE" : "NOCREATEROLE"}
      NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await root.query(`CREATE ROLE ${r} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await root.query(`CREATE ROLE ${s} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await root.query(`ALTER DATABASE postgres OWNER TO ${m}`);
    if (mode === "operator-provisioned") {
      await root.query(`CREATE ROLE ${o} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = pool(namedUrl(o));
      for (const group of groups) {
        await operator.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await operator.query(`GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group))
          await operator.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${o}`);
      }
    }
    // The observed provider principal is a non-superuser with the documented
    // CREATEROLE/CREATEDB shape and a managed elevated-role membership.
    const selection: QualifiedAdminPostgresInstallation = mode === "installer-managed"
      ? { generation: "qualified-admin", roleMode: mode, migrationLogin: m, bootstrapLogin: "host_bootstrap", runtimeLogin: r,
        restoreLogin: s, trustedControlPlane: { roleNames: [provider, rootName] } }
      : { generation: "qualified-admin", roleMode: mode, migrationLogin: m, bootstrapLogin: "host_bootstrap", runtimeLogin: r,
        restoreLogin: s, operatorLogin: o, trustedControlPlane: { roleNames: [provider, rootName] } };
    if (shape === "rds") {
      selection.target = "rds"; selection.layout = "serial-cluster";
    }
    const url = new URL(namedUrl(m)); url.searchParams.set("options", qualifiedAdminPostgresStartupOptions(selection));
    const owner = pool(url.toString());
    const runner = createPostgresMigrationRunner({ connectionString: namedUrl(m) }, { installation: selection, poolFactory: () => owner });
    const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
      "qualified-admin", { roleMode: mode });
    // This small admission discriminator runs before the full migration/restore.
    expect((await owner.query("SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_catalog.pg_roles WHERE rolname=$1",
      [selection.bootstrapLogin])).rows).toEqual([{ rolsuper: false, rolcreaterole: true, rolcreatedb: true }]);
    await expect(owner.query("SELECT * FROM pg_catalog.pg_control_system()")).rejects.toMatchObject({ code: "42501" });
    expect(1 + manifest.forward.length).toBe(installationInventory.current.profiles[mode === "installer-managed" ? "admin-managed" : "admin-operator"].count);
    expect((await runner.status()).pending).toHaveLength(1 + manifest.forward.length);
    if (apply) {
      expect((await runner.apply()).applied).toHaveLength(1 + manifest.forward.length);
      expect((await runner.status()).pending).toEqual([]);
    }
    return { container, pools, owner, runner, selection, inventory: manifest.objectInventorySha256 };
  } catch (error) { await closePostgres(container, pools); throw error; }
}

// Bounds source/target provisioning to two concurrent containers per test and
// tears down any fulfilled container before rethrowing a partial setup failure.
async function installPair(shape: Shape, mode: Mode, sourceLabel: string, targetLabel: string): Promise<[Installed, Installed]> {
  const [sourceResult, targetResult] = await Promise.allSettled([
    install(shape, mode, sourceLabel),
    install(shape, mode, targetLabel),
  ]);
  if (sourceResult.status === "fulfilled" && targetResult.status === "fulfilled") {
    return [sourceResult.value, targetResult.value];
  }
  const containers: PostgresContainer[] = [];
  const pools: Pool[] = [];
  for (const result of [sourceResult, targetResult]) {
    if (result.status === "fulfilled") {
      containers.push(result.value.container);
      pools.push(...result.value.pools);
    }
  }
  const setupError = sourceResult.status === "rejected" ? sourceResult.reason : (targetResult as PromiseRejectedResult).reason;
  if (containers.length > 0) {
    try {
      await closePostgres(containers, pools);
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], "Restricted restore pair setup and cleanup failed");
    }
  }
  throw setupError;
}

async function withAcquisitionOwnerWindow<T>(installed: Installed, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await installed.owner.connect();
  try {
    // Host-owned window: the trusted migrator can reacquire this exact owner
    // capability, then seal it before any later qualification observation.
    await client.query("GRANT platform_acquisition_owner TO restore_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY restore_m");
    return await work(client);
  } finally {
    await client.query("REVOKE platform_acquisition_owner FROM restore_m GRANTED BY restore_m");
    client.release();
  }
}
async function capture(installed: Installed, sourceId: string) {
  return withAcquisitionOwnerWindow(installed, client =>
    captureConnectedNativeStore({ sourceId, catalogueId: installed.inventory, maximumRows: 10000,
      maximumBytes: 64 * 1024 * 1024, source: { async withSnapshot(work) {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
          await client.query("COMMIT"); return result;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      } } }));
}
async function keyIdentity(installed: Installed) {
  return withAcquisitionOwnerWindow(installed, async client =>
    (await client.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows);
}

const feedbackTable = "subscription_cancel_feedback";
const feedbackRoutine = "public.subscription_cancel_feedback_submit(uuid,uuid,text,boolean)";
const reason = "schedule";
const alternateReason = "other";
const packetDigest = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

function feedbackRuntime(installed: Installed): Pool {
  const url = new URL(installed.container.connectionString);
  url.username = installed.selection.runtimeLogin;
  const pool = new Pool({ connectionString: url.toString() });
  installed.pools.push(pool);
  return pool;
}

function commands(runtime: Pool) {
  return createPostgresSubscriptionCommands({
    lifecycleTerms: { pauseDays: 14, pauseMonths: 1, slideMinDays: 1, slideMaxDays: 30, orderNowDelayMinutes: 15, reactivateDelayDays: 1 },
    futureTerms: async () => { throw new Error("cancel has no future terms"); },
    async withTransaction(work) {
      const db = await runtime.connect();
      try {
        await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const result = await work(db);
        await db.query("COMMIT");
        return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
  });
}

async function cancelSubscription(owner: Pool, runtime: Pool) {
  const actorId = randomUUID();
  const { rows: [subject] } = await owner.query<{ id: string; client_id: string; requested_at: string }>(`WITH client AS (
    INSERT INTO public.clients(email,lifecycle_stage) VALUES($1,'lead') RETURNING id
  )
  INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at)
    SELECT id,28,now()+interval '28 days' FROM client
    RETURNING id,client_id,now()::text AS requested_at`, [`${actorId}@example.invalid`]);
  const command = {
    actor: { kind: "customer", actorId, clientId: subject!.client_id },
    subscriptionId: subject!.id, idempotencyKey: randomUUID(), now: subject!.requested_at,
    action: "cancel", reason: null, survey: null, saveOffer: null, confirmedChargeTiming: false,
  } satisfies SubscriptionCommand;
  const receipt = await commands(runtime).apply(command);
  if (!("eventId" in receipt) || receipt.outcome !== "applied" || !receipt.eventId) {
    throw new Error("Fixture cancellation did not commit");
  }
  return { command, receipt, event: receipt.eventId, client: subject!.client_id };
}

async function submitFeedback(db: Pool | PoolClient, event: string, client: string, code: string | null, offered: boolean | null) {
  return (await db.query<{ status: string }>("SELECT public.subscription_cancel_feedback_submit($1,$2,$3,$4) AS status",
    [event, client, code, offered])).rows[0]!.status;
}

async function cancellationRows(owner: Pool, subscriptionId: string) {
  return (await owner.query(`SELECT to_jsonb(s)::text AS subscription,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)::text FROM public.subscription_events e WHERE e.subscription_id=s.id) AS events,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)::text FROM public.subscription_command_receipts r WHERE r.subscription_id=s.id) AS receipts
    FROM public.subscriptions s WHERE s.id=$1`, [subscriptionId])).rows;
}

// Only two independent single-container cases; Vitest drains them before the next serial test.
it.concurrent.each(["installer-managed", "operator-provisioned"] as const)("cx1r_feedback_native_admission_and_replay (%s)", async mode => {
  const source = await install("neon", mode, "cancel-feedback");
  try {
    const runtime = feedbackRuntime(source);
    const before = await cancelSubscription(source.owner, runtime);
    const { event, client, command, receipt } = before;
    const foreign = (await source.owner.query<{ id: string }>(
      "INSERT INTO public.clients(email,lifecycle_stage) VALUES('foreign@example.invalid','lead') RETURNING id")).rows[0]!.id;
    const wrongEvent = (await source.owner.query<{ id: string }>(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
      VALUES($1,'synthetic.retained','feedback-wrong-event','{}') RETURNING id`, [command.subscriptionId])).rows[0]!.id;
    const retained = await cancellationRows(source.owner, command.subscriptionId);

    const { rows: [acl] } = await source.owner.query(`SELECT c.relrowsecurity AS rls, p.prosecdef AS definer, p.proconfig,
      has_function_privilege($3::name,p.oid,'EXECUTE') AS runtime_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
      has_table_privilege($3::name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS runtime_table,
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS service_table,
      EXISTS (SELECT FROM aclexplode(p.proacl) WHERE grantee=0) AS public_execute,
      EXISTS (SELECT FROM aclexplode(c.relacl) WHERE grantee=0) AS public_table
      FROM pg_proc p, pg_class c WHERE p.oid=$1::regprocedure AND c.oid=$2::regclass`,
    [feedbackRoutine, `public.${feedbackTable}`, source.selection.runtimeLogin]);
    expect(acl).toEqual({ rls: true, definer: true, proconfig: ["search_path=pg_catalog, pg_temp"],
      runtime_execute: true, service_execute: true, runtime_table: false, service_table: false, public_execute: false, public_table: false });
    expect((await runtime.query("SELECT current_user AS role")).rows).toEqual([{ role: source.selection.runtimeLogin }]);
    for (const statement of [
      "SELECT * FROM public.subscription_cancel_feedback",
      "INSERT INTO public.subscription_cancel_feedback (cancel_event_id,reason_code) VALUES (gen_random_uuid(),'schedule')",
      "UPDATE public.subscription_cancel_feedback SET reason_code='other'",
      "DELETE FROM public.subscription_cancel_feedback",
    ]) {
      await expect(runtime.query(statement)).rejects.toMatchObject({ code: "42501" });
    }
    const browser = await runtime.connect();
    try {
      for (const role of ["anon", "authenticated"]) {
        await browser.query(`SET ROLE ${role}`);
        await expect(submitFeedback(browser, event, client, reason, true)).rejects.toMatchObject({ code: "42501" });
        await expect(browser.query("SELECT * FROM public.subscription_cancel_feedback")).rejects.toMatchObject({ code: "42501" });
      }
    } finally { await browser.query("RESET ROLE"); browser.release(); }

    for (const code of [null, "", "a".repeat(121), "Mixed_case", "a-b", "a\n", "ä"]) {
      expect(await submitFeedback(runtime, event, client, code, true)).toBe("invalid_reason");
    }
    const missingEvent = randomUUID();
    for (const [cancelEvent, owner] of [[wrongEvent, client], [missingEvent, client], [event, foreign]] as const) {
      expect(await submitFeedback(runtime, cancelEvent, owner, reason, true)).toBe("cancel_not_found");
    }
    expect(await submitFeedback(runtime, event, foreign, "Mixed_case", true)).toBe("invalid_reason");
    expect(await submitFeedback(runtime, missingEvent, client, "Mixed_case", true)).toBe("invalid_reason");
    for (const offered of [false, null]) {
      expect(await submitFeedback(runtime, event, client, reason, offered)).toBe("reason_not_offered");
    }
    expect((await source.owner.query("SELECT * FROM public.subscription_cancel_feedback")).rows).toEqual([]);

    await source.owner.query(`CREATE COLLATION public.feedback_loose
      (provider = icu, locale = 'und-u-ka-shifted-ks-level1', deterministic = false)`);
    const submitEquivalent = async (db: Pool | PoolClient, offered: boolean) => {
      const { rows: [result] } = await db.query<{ equal: boolean; status: string }>(`SELECT
        $3::text COLLATE public.feedback_loose = $4::text AS equal,
        public.subscription_cancel_feedback_submit($1,$2,$3::text COLLATE public.feedback_loose,$5) AS status`,
      [event, client, "sche_dule", reason, offered]);
      expect(result!.equal).toBe(true);
      return result!.status;
    };

    const writer = await runtime.connect();
    const same = await runtime.connect();
    const different = await runtime.connect();
    let attempts: Promise<PromiseSettledResult<string>[]> | undefined;
    try {
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(await submitFeedback(writer, event, client, reason, true)).toBe("recorded");
      const pids = await Promise.all([same, different].map(async db => (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
      const { pid } = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0];
      attempts = Promise.allSettled([submitFeedback(same, event, client, reason, true), submitEquivalent(different, true)]);
      // An independent session can share both parent locks while the writer is open.
      const parents = await source.owner.query(`SELECT e.id FROM public.subscriptions s
        JOIN public.subscription_events e ON e.subscription_id=s.id
        WHERE s.id=$1 AND e.id=$2 FOR SHARE OF s,e NOWAIT`, [command.subscriptionId, event]);
      expect(parents.rows).toEqual([{ id: event }]);
      // The rivals have reached INSERT on the sidecar before waiting for the writer.
      await expect.poll(async () => (await source.owner.query(`SELECT count(*)::int AS waiting FROM unnest($1::int[]) waiting(pid)
        WHERE $2::int=ANY(pg_blocking_pids(waiting.pid)) AND EXISTS (SELECT 1 FROM pg_locks l
          WHERE l.pid=waiting.pid AND l.relation='public.subscription_cancel_feedback'::regclass
          AND l.mode='RowExclusiveLock' AND l.granted)`, [pids, pid])).rows[0].waiting).toBe(2);
      await writer.query("COMMIT");
      expect(await attempts).toEqual([{ status: "fulfilled", value: "replayed" }, { status: "fulfilled", value: "reason_conflict" }]);
    } finally {
      await writer.query("ROLLBACK");
      await attempts;
      for (const db of [writer, same, different]) db.release();
    }
    const stored = (await source.owner.query("SELECT * FROM public.subscription_cancel_feedback")).rows;
    expect(stored).toEqual([{ cancel_event_id: event, reason_code: reason, recorded_at: expect.any(Date) }]);
    expect(await submitFeedback(runtime, event, client, reason, false)).toBe("replayed");
    expect(await submitEquivalent(runtime, false)).toBe("reason_conflict");
    expect(await submitFeedback(runtime, event, client, alternateReason, false)).toBe("reason_conflict");
    expect(await submitFeedback(runtime, event, foreign, reason, true)).toBe("cancel_not_found");
    expect((await source.owner.query("SELECT * FROM public.subscription_cancel_feedback")).rows).toEqual(stored);
    expect(await commands(runtime).apply(command)).toEqual({ ...receipt, outcome: "replayed" });
    expect(await cancellationRows(source.owner, command.subscriptionId)).toEqual(retained);
  } finally { await closePostgres(source.container, source.pools); }
}, postgresSetupTimeoutMs);

it("cx1r_feedback_retries_when_winner_is_deleted", async () => {
  const source = await install("neon", "operator-provisioned", "vanished-feedback");
  try {
    const runtime = feedbackRuntime(source);
    const { event, client } = await cancelSubscription(source.owner, runtime);
    // Test-only barrier after an INSERT that changed no rows.
    await source.owner.query(`CREATE FUNCTION public.pause_skipped_feedback_insert() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM inserted_feedback) THEN
          PERFORM pg_advisory_xact_lock(38145, 1);
        END IF;
        RETURN NULL;
      END;
      $$;
      CREATE TRIGGER pause_skipped_feedback_insert AFTER INSERT ON public.subscription_cancel_feedback
      REFERENCING NEW TABLE AS inserted_feedback FOR EACH STATEMENT
      EXECUTE FUNCTION public.pause_skipped_feedback_insert()`);
    const owner = await source.owner.connect();
    const writer = await runtime.connect();
    let pending: Promise<PromiseSettledResult<string>[]> | undefined;
    try {
      const { rows: [{ pid }] } = await writer.query("SELECT pg_backend_pid() AS pid");
      await owner.query("SELECT pg_advisory_lock(38145, 1)");
      await owner.query("BEGIN");
      await owner.query("INSERT INTO public.subscription_cancel_feedback(cancel_event_id,reason_code) VALUES ($1,$2)", [event, reason]);
      pending = Promise.allSettled([submitFeedback(writer, event, client, alternateReason, true)]);
      await expect.poll(async () => (await owner.query("SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS waiting", [pid])).rows[0].waiting)
        .toBe(true);
      await owner.query("COMMIT");
      await expect.poll(async () => (await owner.query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1
        AND locktype='advisory' AND NOT granted) AS paused`, [pid])).rows[0].paused).toBe(true);
      await owner.query("SET lock_timeout = '5s'");
      const erased = await owner.query("DELETE FROM public.subscription_cancel_feedback WHERE cancel_event_id=$1 RETURNING reason_code", [event]);
      expect(erased.rows).toEqual([{ reason_code: reason }]);
      await owner.query("SELECT pg_advisory_unlock(38145, 1)");
      expect(await pending).toEqual([{ status: "fulfilled", value: "recorded" }]);
      expect(await submitFeedback(writer, event, client, alternateReason, false)).toBe("replayed");
    } finally {
      await owner.query("ROLLBACK");
      await owner.query("SELECT pg_advisory_unlock(38145, 1)");
      await owner.query("RESET lock_timeout");
      await pending;
      owner.release();
      writer.release();
    }
  } finally { await closePostgres(source.container, source.pools); }
}, postgresSetupTimeoutMs);

it("cx1r_feedback_full_store_round_trip", async () => {
  const [source, target] = await installPair("neon", "operator-provisioned", "feedback-source", "feedback-target");
  try {
    const sourceRuntime = feedbackRuntime(source);
    const { event, client, command, receipt } = await cancelSubscription(source.owner, sourceRuntime);
    expect(await submitFeedback(sourceRuntime, event, client, reason, true)).toBe("recorded");
    await source.owner.query(`UPDATE public.subscription_cancel_feedback
      SET recorded_at=date_trunc('second',recorded_at)+interval '0.123456 seconds' WHERE cancel_event_id=$1`, [event]);
    const packet = await capture(source, "cancel-feedback-source");
    const sidecar = packet.owned.find(entry => entry.table === feedbackTable)!;
    expect(sidecar.rows.map(row => JSON.parse(row))).toEqual([{
      cancel_event_id: event, reason_code: reason, recorded_at: expect.stringMatching(/\.123456\+00:00$/u),
    }]);
    const sourceEvents = packet.compatible.tables.find(entry => entry.table === "subscription_events")!;
    const sourceReceipts = packet.owned.find(entry => entry.table === "subscription_command_receipts")!;
    expect(sourceEvents.rows.map(row => JSON.parse(row).id)).toEqual([event]);
    expect(sourceReceipts.rows.map(row => JSON.parse(row).command_fingerprint)).toEqual([receipt.commandFingerprint]);

    const privateName = feedbackTable as unknown as CompatiblePostgresTable;
    const noDatabase = async () => { throw new Error("The public utility must refuse before connecting"); };
    await expect(captureCompatiblePostgresRows({
      source: { withSnapshot: noDatabase }, sourceId: packet.compatible.sourceId, catalogueId: source.inventory,
      tables: [privateName], maximumRows: 10, maximumBytes: 1024,
    })).rejects.toMatchObject({ code: "unsupported_table" });
    const { sha256: _compatibleDigest, ...compatible } = packet.compatible;
    const publicBody = { ...compatible, tables: [{
      ...sidecar, table: privateName, columns: sidecar.columns.map(column => ({ ...column, key: column.name === "cancel_event_id" })),
    }] };
    await expect(restoreCompatiblePostgresRows({
      target: { withTransaction: noDatabase }, catalogueId: source.inventory,
      packet: { ...publicBody, sha256: packetDigest(publicBody) },
    })).rejects.toMatchObject({ code: "unsupported_table" });

    const freshTarget = await capture(target, "cancel-feedback-fresh-target");
    const input = { owner: target.owner, installation: target.selection, packet, freshTarget };
    const changed = structuredClone(packet);
    changed.owned.find(entry => entry.table === feedbackTable)!.rows[0] = sidecar.rows[0]!.replace(`"${reason}"`, `"${alternateReason}"`);
    await expect(restoreConnectedNativeStore({ ...input, packet: changed })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await restoreConnectedNativeStore(input)).toMatchObject({ replayed: false });
    const { sha256: _ownerDigest, ...changedBody } = changed;
    await expect(restoreConnectedNativeStore({ ...input, packet: { ...changedBody, sha256: packetDigest(changedBody) } }))
      .rejects.toMatchObject({ code: "target_conflict" });
    const targetRuntime = feedbackRuntime(target);
    expect(await submitFeedback(targetRuntime, event, client, reason, false)).toBe("replayed");
    expect(await commands(targetRuntime).apply(command)).toEqual({ ...receipt, outcome: "replayed" });
    expect(await restoreConnectedNativeStore(input)).toMatchObject({ replayed: true });
    const restored = await capture(target, "cancel-feedback-restored-target");
    expect(restored.owned.find(entry => entry.table === feedbackTable)).toEqual(sidecar);
    expect(restored.owned.find(entry => entry.table === "subscription_command_receipts")).toEqual(sourceReceipts);
    expect(restored.compatible.tables.find(entry => entry.table === "subscription_events")).toEqual(sourceEvents);
  } finally {
    await closePostgres([target.container, source.container], [...target.pools, ...source.pools]);
  }
}, 245_000);

it("keeps the elevated control-plane membership requirement for self-host selections", async () => {
  const fixture = await install("rds", "installer-managed", "self-host-scope", false);
  try {
    delete fixture.selection.target; delete fixture.selection.layout;
    await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
  } finally { await closePostgres(fixture.container, fixture.pools); }
}, postgresSetupTimeoutMs);

it("does not let an RDS declaration trust a non-stock role without elevated flags", async () => {
  const fixture = await install("rds", "installer-managed", "non-stock-authority", false);
  try {
    await fixture.pools[0]!.query(`CREATE ROLE declared_outsider NOLOGIN; REVOKE rds_superuser FROM host_bootstrap;
      GRANT declared_outsider TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    fixture.selection.trustedControlPlane = { roleNames: [...fixture.selection.trustedControlPlane!.roleNames, "declared_outsider"] };
    await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
  } finally { await closePostgres(fixture.container, fixture.pools); }
}, postgresSetupTimeoutMs);

for (const role of ["rds_password", "rds_iam", "rds_ad"] as const) {
  it(`does not count bootstrap membership only in ${role} as RDS authority`, async () => {
    const fixture = await install("rds", "installer-managed", `non-authority-${role}`, false);
    try {
      await fixture.pools[0]!.query(`CREATE ROLE ${role} NOLOGIN; REVOKE rds_superuser FROM host_bootstrap;
        GRANT ${role} TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      fixture.selection.trustedControlPlane = { roleNames: [...fixture.selection.trustedControlPlane!.roleNames, role] };
      await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
      await fixture.pools[0]!.query("GRANT rds_superuser TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE");
      expect((await fixture.runner.status()).pending).toHaveLength(1 + selectPlatformMigrationManifest(JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8')), 'qualified-admin', { roleMode: fixture.selection.roleMode }).forward.length);
    } finally { await closePostgres(fixture.container, fixture.pools); }
  }, postgresSetupTimeoutMs);
}

for (const outside of ["grantor", "member"] as const) {
  it(`compares RDS predefined-role edges with a non-stock ${outside}`, async () => {
    const fixture = await install(outside === "grantor" ? "neon" : "rds", "installer-managed", `non-stock-${outside}`, false);
    try {
      fixture.selection.target = "rds"; fixture.selection.layout = "serial-cluster";
      const outsideName = outside === "grantor" ? "rds_superuser" : "declared_outsider";
      await fixture.pools[0]!.query(`CREATE ROLE ${outsideName} NOLOGIN`);
      fixture.selection.trustedControlPlane = { roleNames: [...fixture.selection.trustedControlPlane!.roleNames, outsideName] };
      expect((await fixture.runner.status()).pending).toHaveLength(1 + selectPlatformMigrationManifest(JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8')), 'qualified-admin', { roleMode: fixture.selection.roleMode }).forward.length);
      await fixture.pools[0]!.query(`GRANT pg_monitor TO ${outsideName} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      await expect(fixture.runner.status()).rejects.toThrow("protected_membership_graph_differs");
    } finally { await closePostgres(fixture.container, fixture.pools); }
  }, postgresSetupTimeoutMs);
}

for (const shape of ["neon", "rds"] as const) for (const mode of ["installer-managed", "operator-provisioned"] as const) {
  it(`admits ${shape}-shaped ${mode} control-plane roles before installation`, async () => {
    if (!await dockerAvailable()) throw new Error("Restricted admission requires disposable PostgreSQL 16");
    const fixture = await install(shape, mode, "admission", false);
    try {
      const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
      await fixture.pools[0]!.query(`REVOKE ${provider} FROM host_bootstrap`);
      await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
      await fixture.pools[0]!.query(`GRANT ${provider} TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      await fixture.pools[0]!.query("CREATE ROLE rogue_host CREATEROLE");
      await expect(fixture.runner.status()).rejects.toThrow("outside_role_has_host_authority");
    } finally { await closePostgres(fixture.container, fixture.pools); }
  }, postgresSetupTimeoutMs);
  it(`restores a connected native graph through ${shape}-shaped ${mode} admission`, async () => {
    if (!await dockerAvailable()) throw new Error("Restricted restore requires disposable PostgreSQL 16");
    const [source, target] = await installPair(shape, mode, "source", "target");
    try {
      const { rows: [subscription] } = await source.owner.query<{ id: string }>(`WITH client AS (
        INSERT INTO public.clients(email,lifecycle_stage) VALUES('restricted@example.invalid','lead') RETURNING id
      )
      INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at)
        SELECT id,28,'2026-11-29T12:00:00Z' FROM client RETURNING id`);
      await source.owner.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,
        quote_hash,expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
        VALUES($1,'fixture-quote',repeat('b',64),repeat('c',64),1,'[]',28,200,200,'XXX','2026-11-02')`, [subscription!.id]);
      await source.owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
        VALUES('synthetic','10000000-0000-4000-8000-000000000001','synthetic.retained','restricted-ordinary-outbox','{}')`);
      const packet = await capture(source, "restricted-source");
      const quotes = packet.owned.find(entry => entry.table === "subscription_edit_quotes");
      expect(quotes!.rows).toHaveLength(1);
      const freshTarget = await capture(target, "restricted-target");
      expect((await source.runner.status()).pending).toEqual([]);
      expect((await target.runner.status()).pending).toEqual([]);
      expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
      const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
      await target.pools[0]!.query(`GRANT ${provider} TO restore_r`);
      await expect(target.runner.status()).rejects.toThrow("protected_membership_graph_differs");
      await target.pools[0]!.query(`REVOKE ${provider} FROM restore_r`);
      const beforeKey = await keyIdentity(target);
      const input = { owner: target.owner, installation: target.selection, packet, freshTarget };
      await target.owner.query("INSERT INTO public.commerce_settings(key,value_minor) VALUES('transfer_conflict',1)");
      await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "target_conflict" });
      await target.owner.query("DELETE FROM public.commerce_settings WHERE key='transfer_conflict'");
      expect((await target.runner.status()).pending).toEqual([]);
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(false);
      expect((await target.owner.query("SELECT email FROM public.clients")).rows).toEqual([{ email: "restricted@example.invalid" }]);
      expect((await capture(target, "restricted-restored")).owned.find(entry => entry.table === "subscription_edit_quotes")).toEqual(quotes);
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
      expect((await target.owner.query("SELECT event_type FROM public.outbox_events")).rows).toEqual([{ event_type: "synthetic.retained" }]);
      if (shape === "neon" && mode === "installer-managed") {
        // A separate administrator changes the ledger after the first exact
        // read but just before restore locks the table. Replay must recheck it.
        const root = target.pools[0]!;
        const original = (await root.query<{ sha256: string }>(
          "SELECT sha256 FROM public.platform_schema_migrations WHERE position=0")).rows[0]!.sha256;
        const changed = `${original[0] === "f" ? "e" : "f"}${original.slice(1)}`;
        let raced = false, closed = false;
        const racingOwner = { async connect() {
          const client = await target!.owner.connect();
          return {
            async query(sql: string | QueryConfig, values?: unknown[]) {
              const text = typeof sql === "string" ? sql : sql.text;
              if (!raced && text.includes('LOCK TABLE "public"."platform_schema_migrations"')) {
                await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [changed]);
                raced = true;
              }
              const result = typeof sql === "string" ? await client.query(sql, values) : await client.query(sql);
              if (text.startsWith("REVOKE platform_acquisition_owner")) closed = true;
              return result;
            },
            release: (destroy?: boolean) => client.release(destroy),
          };
        } } as unknown as Pool;
        try {
          await expect(restoreConnectedNativeStore({ ...input, owner: racingOwner })).rejects.toMatchObject({ code: "schema_conflict" });
          expect(raced).toBe(true);
          expect(closed).toBe(true);
        } finally {
          await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [original]);
        }
        expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
      }
      expect(await keyIdentity(target)).toEqual(beforeKey);
      await expect(restoreConnectedNativeStore({ ...input, freshTarget: packet })).rejects.toMatchObject({ code: "invalid_input" });
      const restoreLogin = new Pool({ connectionString: (() => {
        const url = new URL(target.container.connectionString); url.username = target.selection.restoreLogin; return url.toString();
      })() });
      target.pools.push(restoreLogin);
      await expect(restoreLogin.query("UPDATE public.clients SET email='forbidden@example.invalid'")).rejects.toMatchObject({ code: "42501" });
      await expect(restoreLogin.query("SELECT * FROM acquisition_private.installation_key")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await closePostgres([target.container, source.container], [...target.pools, ...source.pools]);
    }
  // About 4x the slowest hosted run (60,506 ms), rounded up to 5 s.
  }, 245_000);
}
