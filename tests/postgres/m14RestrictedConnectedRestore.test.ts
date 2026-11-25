import { captureCompatiblePostgresRows, restoreCompatiblePostgresRows, type CompatiblePostgresTable } from "@openlup/platform/portability";
import { createPostgresSubscriptionCommands } from "@openlup/platform/subscriptions";
import type { SubscriptionCommand } from "@openlup/platform/subscriptions/contracts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import ts from "typescript";
import { aroundEach, expect, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { closePostgres, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { findPlatformMigration } from "../helpers/platformMigrationPath.js";
import { draftEffectCounts, ownerDraft, seedGovernedDraft } from "./catalogAdmissionOwnerWrite.fixture.js";
import {
  captureRestrictedStore,
  installRestrictedRestore,
  installRestrictedRestorePair,
  type RestrictedRestoreInstalled,
  type RestrictedRestoreMode,
} from "./m14RestrictedConnectedRestore.fixture.js";

const feedbackTable = "subscription_cancel_feedback";
const feedbackRoutine = "public.subscription_cancel_feedback_submit(uuid,uuid,text,boolean)";
const reason = "schedule";
const alternateReason = "other";
const packetDigest = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

function feedbackRuntime(installed: RestrictedRestoreInstalled): Pool {
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

async function verifyFeedbackAdmission(mode: RestrictedRestoreMode, expectCase: typeof expect) {
  const source = await installRestrictedRestore("neon", mode, "cancel-feedback", true, expectCase);
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
    expectCase(acl).toEqual({ rls: true, definer: true, proconfig: ["search_path=pg_catalog, pg_temp"],
      runtime_execute: true, service_execute: true, runtime_table: false, service_table: false, public_execute: false, public_table: false });
    expectCase((await runtime.query("SELECT current_user AS role")).rows).toEqual([{ role: source.selection.runtimeLogin }]);
    for (const statement of [
      "SELECT * FROM public.subscription_cancel_feedback",
      "INSERT INTO public.subscription_cancel_feedback (cancel_event_id,reason_code) VALUES (gen_random_uuid(),'schedule')",
      "UPDATE public.subscription_cancel_feedback SET reason_code='other'",
      "DELETE FROM public.subscription_cancel_feedback",
    ]) {
      await expectCase(runtime.query(statement)).rejects.toMatchObject({ code: "42501" });
    }
    const browser = await runtime.connect();
    try {
      for (const role of ["anon", "authenticated"]) {
        await browser.query(`SET ROLE ${role}`);
        await expectCase(submitFeedback(browser, event, client, reason, true)).rejects.toMatchObject({ code: "42501" });
        await expectCase(browser.query("SELECT * FROM public.subscription_cancel_feedback")).rejects.toMatchObject({ code: "42501" });
      }
    } finally { await browser.query("RESET ROLE"); browser.release(); }

    for (const code of [null, "", "a".repeat(121), "Mixed_case", "a-b", "a\n", "ä"]) {
      expectCase(await submitFeedback(runtime, event, client, code, true)).toBe("invalid_reason");
    }
    const missingEvent = randomUUID();
    for (const [cancelEvent, owner] of [[wrongEvent, client], [missingEvent, client], [event, foreign]] as const) {
      expectCase(await submitFeedback(runtime, cancelEvent, owner, reason, true)).toBe("cancel_not_found");
    }
    expectCase(await submitFeedback(runtime, event, foreign, "Mixed_case", true)).toBe("invalid_reason");
    expectCase(await submitFeedback(runtime, missingEvent, client, "Mixed_case", true)).toBe("invalid_reason");
    for (const offered of [false, null]) {
      expectCase(await submitFeedback(runtime, event, client, reason, offered)).toBe("reason_not_offered");
    }
    expectCase((await source.owner.query("SELECT * FROM public.subscription_cancel_feedback")).rows).toEqual([]);

    await source.owner.query(`CREATE COLLATION public.feedback_loose
      (provider = icu, locale = 'und-u-ka-shifted-ks-level1', deterministic = false)`);
    const submitEquivalent = async (db: Pool | PoolClient, offered: boolean) => {
      const { rows: [result] } = await db.query<{ equal: boolean; status: string }>(`SELECT
        $3::text COLLATE public.feedback_loose = $4::text AS equal,
        public.subscription_cancel_feedback_submit($1,$2,$3::text COLLATE public.feedback_loose,$5) AS status`,
      [event, client, "sche_dule", reason, offered]);
      expectCase(result!.equal).toBe(true);
      return result!.status;
    };

    const writer = await runtime.connect();
    const same = await runtime.connect();
    const different = await runtime.connect();
    let attempts: Promise<PromiseSettledResult<string>[]> | undefined;
    try {
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      expectCase(await submitFeedback(writer, event, client, reason, true)).toBe("recorded");
      const pids = await Promise.all([same, different].map(async db => (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
      const { pid } = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0];
      attempts = Promise.allSettled([submitFeedback(same, event, client, reason, true), submitEquivalent(different, true)]);
      // An independent session can share both parent locks while the writer is open.
      const parents = await source.owner.query(`SELECT e.id FROM public.subscriptions s
        JOIN public.subscription_events e ON e.subscription_id=s.id
        WHERE s.id=$1 AND e.id=$2 FOR SHARE OF s,e NOWAIT`, [command.subscriptionId, event]);
      expectCase(parents.rows).toEqual([{ id: event }]);
      // The rivals have reached INSERT on the sidecar before waiting for the writer.
      await expectCase.poll(async () => (await source.owner.query(`SELECT count(*)::int AS waiting FROM unnest($1::int[]) waiting(pid)
        WHERE $2::int=ANY(pg_blocking_pids(waiting.pid)) AND EXISTS (SELECT 1 FROM pg_locks l
          WHERE l.pid=waiting.pid AND l.relation='public.subscription_cancel_feedback'::regclass
          AND l.mode='RowExclusiveLock' AND l.granted)`, [pids, pid])).rows[0].waiting).toBe(2);
      await writer.query("COMMIT");
      expectCase(await attempts).toEqual([{ status: "fulfilled", value: "replayed" }, { status: "fulfilled", value: "reason_conflict" }]);
    } finally {
      await writer.query("ROLLBACK");
      await attempts;
      for (const db of [writer, same, different]) db.release();
    }
    const stored = (await source.owner.query("SELECT * FROM public.subscription_cancel_feedback")).rows;
    expectCase(stored).toEqual([{ cancel_event_id: event, reason_code: reason, recorded_at: expectCase.any(Date) }]);
    expectCase(await submitFeedback(runtime, event, client, reason, false)).toBe("replayed");
    expectCase(await submitEquivalent(runtime, false)).toBe("reason_conflict");
    expectCase(await submitFeedback(runtime, event, client, alternateReason, false)).toBe("reason_conflict");
    expectCase(await submitFeedback(runtime, event, foreign, reason, true)).toBe("cancel_not_found");
    expectCase((await source.owner.query("SELECT * FROM public.subscription_cancel_feedback")).rows).toEqual(stored);
    expectCase(await commands(runtime).apply(command)).toEqual({ ...receipt, outcome: "replayed" });
    expectCase(await cancellationRows(source.owner, command.subscriptionId)).toEqual(retained);
  } finally { await closePostgres(source.container, source.pools); }
}

const activeSerialFixtures = new Set<Promise<void>>();
const activeConcurrentFixtures = new Set<Promise<void>>();

aroundEach(async (runTest, { signal, task }) => {
  // Vitest can time out the case without cancelling its database work.
  await Promise.all(activeSerialFixtures);
  if (!task.concurrent) await Promise.all(activeConcurrentFixtures);
  signal.throwIfAborted();
  await runTest();
}, postgresSetupTimeoutMs);

function trackFixture(active: Set<Promise<void>>, work: () => Promise<void>) {
  const result = work();
  const drained = result.then(() => undefined, () => undefined);
  active.add(drained);
  void drained.then(() => active.delete(drained));
  return result;
}

function restoreTest(name: string, work: () => Promise<void>, timeout: number) {
  it(name, () => trackFixture(activeSerialFixtures, work), timeout);
}

// Use each case's own assertion context and wait for cleanup even after a case times out.
it.concurrent.for(["installer-managed", "operator-provisioned"] as const)(
  "cx1r_feedback_native_admission_and_replay (%s)", { timeout: postgresSetupTimeoutMs }, async (mode, { expect, onTestFinished }) => {
    const work = trackFixture(activeConcurrentFixtures, () => verifyFeedbackAdmission(mode, expect));
    onTestFinished(({ signal }) => signal.aborted ? work : undefined, postgresSetupTimeoutMs);
    await work;
  });

restoreTest("cx1r_feedback_retries_when_winner_is_deleted", async () => {
  const source = await installRestrictedRestore("neon", "operator-provisioned", "vanished-feedback");
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

restoreTest("cx1r_feedback_full_store_round_trip", async () => {
  const [source, target] = await installRestrictedRestorePair("neon", "operator-provisioned", "feedback-source", "feedback-target");
  try {
    const sourceRuntime = feedbackRuntime(source);
    const { event, client, command, receipt } = await cancelSubscription(source.owner, sourceRuntime);
    expect(await submitFeedback(sourceRuntime, event, client, reason, true)).toBe("recorded");
    await source.owner.query(`UPDATE public.subscription_cancel_feedback
      SET recorded_at=date_trunc('second',recorded_at)+interval '0.123456 seconds' WHERE cancel_event_id=$1`, [event]);
    const packet = await captureRestrictedStore(source, "cancel-feedback-source");
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

    const freshTarget = await captureRestrictedStore(target, "cancel-feedback-fresh-target");
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
    const restored = await captureRestrictedStore(target, "cancel-feedback-restored-target");
    expect(restored.owned.find(entry => entry.table === feedbackTable)).toEqual(sidecar);
    expect(restored.owned.find(entry => entry.table === "subscription_command_receipts")).toEqual(sourceReceipts);
    expect(restored.compatible.tables.find(entry => entry.table === "subscription_events")).toEqual(sourceEvents);
  } finally {
    await closePostgres([target.container, source.container], [...target.pools, ...source.pools]);
  }
}, 245_000);

restoreTest("keeps the elevated control-plane membership requirement for self-host selections", async () => {
  const fixture = await installRestrictedRestore("rds", "installer-managed", "self-host-scope", false);
  try {
    delete fixture.selection.target; delete fixture.selection.layout;
    await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
  } finally { await closePostgres(fixture.container, fixture.pools); }
}, postgresSetupTimeoutMs);

restoreTest("does not let an RDS declaration trust a non-stock role without elevated flags", async () => {
  const fixture = await installRestrictedRestore("rds", "installer-managed", "non-stock-authority", false);
  try {
    await fixture.pools[0]!.query(`CREATE ROLE declared_outsider NOLOGIN; REVOKE rds_superuser FROM host_bootstrap;
      GRANT declared_outsider TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    fixture.selection.trustedControlPlane = { roleNames: [...fixture.selection.trustedControlPlane!.roleNames, "declared_outsider"] };
    await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
  } finally { await closePostgres(fixture.container, fixture.pools); }
}, postgresSetupTimeoutMs);

for (const role of ["rds_password", "rds_iam", "rds_ad"] as const) {
  restoreTest(`does not count bootstrap membership only in ${role} as RDS authority`, async () => {
    const fixture = await installRestrictedRestore("rds", "installer-managed", `non-authority-${role}`, false);
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
  restoreTest(`compares RDS predefined-role edges with a non-stock ${outside}`, async () => {
    const fixture = await installRestrictedRestore(outside === "grantor" ? "neon" : "rds", "installer-managed", `non-stock-${outside}`, false);
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

restoreTest("refuses populated outside-profile relations before the dirty-target check", async () => {
  const [source, target] = await installRestrictedRestorePair("neon", "installer-managed", "outside-source", "outside-target");
  try {
    const packet = await captureRestrictedStore(source, "outside-source");
    const freshTarget = await captureRestrictedStore(target, "outside-pristine");
    await target.owner.query(`WITH buyer AS (INSERT INTO public.clients(email) VALUES('outside@example.invalid') RETURNING id)
      INSERT INTO public.customer_identity_challenges(client_id,principal_id,email_fingerprint,token_hash,expires_at)
      SELECT id,gen_random_uuid(),repeat('a',64),repeat('b',64),clock_timestamp()+interval '1 hour' FROM buyer`);
    await expect(restoreConnectedNativeStore({ owner: target.owner, installation: target.selection, packet, freshTarget }))
      .rejects.toMatchObject({ code: "unsupported_table", table: "public.customer_identity_challenges" });
  } finally {
    await Promise.all([source, target].map(store => closePostgres(store.container, store.pools)));
  }
}, postgresSetupTimeoutMs);

function restoreInsertAllowlist(): string[] {
  const path = "server/adapters/postgres/connectedStoreRestore.ts";
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  const census = source.statements.filter(ts.isFunctionDeclaration).find(statement => statement.name?.text === "assertInsertTriggers");
  const allowed = census?.body?.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "allowed")?.initializer;
  if (!allowed || !ts.isObjectLiteralExpression(allowed)) throw new Error("Restore INSERT trigger allowlist missing");
  return allowed.properties.flatMap(property => {
    if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)
      || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error("Expected literal trigger allowlist entries");
    const table = property.name.text;
    return property.initializer.elements.map(name => {
      if (!ts.isStringLiteral(name)) throw new Error("Expected a literal trigger name");
      return `${table}.${name.text}`;
    });
  }).sort();
}

restoreTest("restores unstamped rows with exactly the installed INSERT triggers", async () => {
  const [source, target] = await installRestrictedRestorePair("neon", "installer-managed", "unstamped-source", "unstamped-target");
  try {
    await source.owner.query(`INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor,created_at,updated_at,metadata)
      VALUES('10000000-0000-4000-8000-000000000001','pending_payment','XTS',0,
        '2026-01-02T03:04:05.123456Z','2026-01-02T03:04:05.123456Z','{"source":"fixture"}')`);
    const packet = await captureRestrictedStore(source, "unstamped-order");
    const freshTarget = await captureRestrictedStore(target, "unstamped-pristine");
    const tables = [...packet.compatible.tables, ...packet.owned].map(table => table.table);
    const forward = findPlatformMigration("_catalog_governed_draft_owner.sql");
    // The runner commits each forward and its ledger row in the same transaction.
    const { rows: triggers } = await target.owner.query<{ name: string; carried: boolean; installed: boolean }>(`
      SELECT c.relname || '.' || t.tgname AS name, c.relname=ANY($2::text[]) AS carried, t.xmin=m.xmin AS installed
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN public.platform_schema_migrations m
      WHERE m.catalog_path=$1 AND n.nspname='public' AND NOT t.tgisinternal
        AND (t.tgtype & 4)<>0 AND t.tgenabled IN ('O','A')`, [forward, tables]);
    const incumbent = triggers.filter(trigger => trigger.carried && !trigger.installed).map(trigger => trigger.name);
    const installed = triggers.filter(trigger => trigger.installed).map(trigger => trigger.name);
    // The existing allowlist also covers the optional publication authority rail.
    const publicationAuthority = [
      "catalog_price_setup_receipts", "catalog_product_document_revisions", "catalog_products",
      "catalog_sku_identifiers", "catalog_skus", "price_entries",
    ].map(table => `${table}.catalog_publication_live_write`);
    publicationAuthority.push("catalog_publications.catalog_publication_record_write_binding",
      "catalog_publications.catalog_publications_open_draft");
    expect(installed).toHaveLength(5);
    expect(restoreInsertAllowlist()).toStrictEqual([...new Set([...incumbent, ...publicationAuthority]), ...installed].sort());

    await expect(restoreConnectedNativeStore({ owner: target.owner, installation: target.selection, packet, freshTarget }))
      .resolves.toMatchObject({ captureSha256: packet.sha256, replayed: false });
    const restored = await captureRestrictedStore(target, packet.compatible.sourceId);
    expect(restored.owned).toStrictEqual(packet.owned);
    expect(restored.compatible).toStrictEqual(packet.compatible);
    const order = restored.compatible.tables.find(table => table.table === "commerce_orders")!;
    expect(order.rows).toHaveLength(1);
    // The same unstamped order restored on the predecessor schema yields these bytes.
    expect(packetDigest(order)).toBe("f2abc69bd9cea521965e6446e4974e44894a8aba2ee5e4b9f55767458cd45c33");
  } finally {
    await Promise.all([source, target].map(store => closePostgres(store.container, store.pools)));
  }
}, postgresSetupTimeoutMs);

restoreTest("refuses stamped drafts and their marked events before connecting while preserving legacy restore", async () => {
  const [source, target] = await installRestrictedRestorePair("neon", "installer-managed", "governed-source", "governed-target");
  try {
    const fixture = await seedGovernedDraft(source.owner, { product: 3, shipping: 7 });
    // A scalar or array containing the spelling of the key has no object key.
    await source.owner.query(`INSERT INTO public.commerce_orders(status,currency_code,total_amount_minor,metadata)
      VALUES('pending_payment','XTS',0,jsonb_build_array('catalogAdmissionOwnerOrigin'::text))`);
    const legacy = await captureRestrictedStore(source, "legacy-source");
    const freshTarget = await captureRestrictedStore(target, "governed-pristine");
    await ownerDraft(source.owner, fixture);
    const stamped = await captureRestrictedStore(source, "governed-source");
    const input = { owner: target.owner, installation: target.selection, freshTarget };
    const before = await draftEffectCounts(target.owner);
    const table = (capture: typeof legacy, name: "commerce_orders" | "outbox_events") =>
      capture.compatible.tables.find(entry => entry.table === name)!;
    const reseal = ({ sha256: _outer, compatible, ...rest }: typeof legacy) => {
      const { sha256: _inner, ...rows } = compatible;
      const body = { ...rest, compatible: { ...rows, sha256: packetDigest(rows) } };
      return { ...body, sha256: packetDigest(body) };
    };
    const nullMarker = structuredClone(legacy);
    const orderRows = table(nullMarker, "commerce_orders").rows;
    orderRows[0] = JSON.stringify({ ...JSON.parse(orderRows[0]!), metadata: { catalogAdmissionOwnerOrigin: null } });
    const markedEventOnly = structuredClone(legacy);
    const markedEvent = table(stamped, "outbox_events").rows.find(row =>
      JSON.parse(row).metadata?.boundary === "catalog_admission_write_governed_draft");
    expect(markedEvent).toBeDefined();
    table(markedEventOnly, "outbox_events").rows.push(markedEvent!);

    let connections = 0;
    const unopened = { async connect() { connections++; throw new Error("Unexpected target connection"); } } as unknown as Pool;
    const remedy = "This version cannot restore stamped governed drafts. Keep the capture for a version that supports their restore.";
    for (const [packet, relation] of [
      [stamped, "commerce_orders"],
      [reseal(nullMarker), "commerce_orders"],
      [reseal(markedEventOnly), "outbox_events"],
    ] as const) {
      await expect(restoreConnectedNativeStore({ ...input, owner: unopened, packet }))
        .rejects.toMatchObject({ name: "PostgresTransferError", code: "unsupported_table", table: relation, remedy });
    }
    expect(connections).toBe(0);
    expect(await draftEffectCounts(target.owner)).toEqual(before);

    const invalidLegacy = structuredClone(legacy);
    const legacyRows = table(invalidLegacy, "commerce_orders").rows;
    const accepted = table(stamped, "commerce_orders").rows.map(row => JSON.parse(row)).find(row => row.catalog_acceptance !== null);
    legacyRows[0] = JSON.stringify({ ...JSON.parse(legacyRows[0]!), catalog_acceptance: accepted.catalog_acceptance });
    const failure = await restoreConnectedNativeStore({ ...input, packet: reseal(invalidLegacy) }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "target_conflict", cause: {
      outcome: "validation_issue", reason: "catalog_acceptance_receipt_mismatch",
      message: "Supply the persisted draft receipt for this order and retry with its original key.",
    } });
    expect(failure).not.toHaveProperty("remedy");
    expect(await draftEffectCounts(target.owner)).toEqual(before);

    await expect(restoreConnectedNativeStore({ ...input, packet: legacy }))
      .resolves.toMatchObject({ captureSha256: legacy.sha256, replayed: false });
    const retained = await captureRestrictedStore(target, "legacy-restored");
    expect(retained.owned).toStrictEqual(legacy.owned);
    expect(retained.compatible.tables).toStrictEqual(legacy.compatible.tables);
    await expect(restoreConnectedNativeStore({ ...input, packet: legacy }))
      .resolves.toMatchObject({ captureSha256: legacy.sha256, replayed: true });
  } finally {
    await Promise.all([source, target].map(store => closePostgres(store.container, store.pools)));
  }
}, postgresSetupTimeoutMs);
