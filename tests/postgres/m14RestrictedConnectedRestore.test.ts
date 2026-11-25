import { captureCompatiblePostgresRows, restoreCompatiblePostgresRows, type CompatiblePostgresTable } from "@openlup/platform/portability";
import { createPostgresSubscriptionCommands } from "@openlup/platform/subscriptions";
import type { SubscriptionCommand } from "@openlup/platform/subscriptions/contracts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { aroundEach, expect, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { closePostgres, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
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

restoreTest("requires source custody and validates the retained governed graph before committing", async () => {
  const [source, target] = await installRestrictedRestorePair("neon", "installer-managed", "governed-source", "governed-target");
  try {
    const fixture = await seedGovernedDraft(source.owner, { product: 3, shipping: 7 });
    const governed = await ownerDraft(source.owner, fixture);
    await source.owner.query("UPDATE public.commerce_order_draft_receipts SET invalidated_at=clock_timestamp(),invalidation_reason='expired' WHERE order_id=$1", [governed.id]);
    await source.owner.query("INSERT INTO public.commerce_orders(status,currency_code,total_amount_minor) VALUES('pending_payment','XTS',0)");
    await source.owner.query("INSERT INTO public.subscriptions(client_id,cadence_days) VALUES($1,28)", [fixture.original.clientId]);
    const packet = await captureRestrictedStore(source, "governed-source");
    const sourceCustody = packet.sha256;
    const freshTarget = await captureRestrictedStore(target, "governed-pristine");
    const input = { owner: target.owner, installation: target.selection, packet, freshTarget, trustedSourceCaptureSha256: sourceCustody };
    const rehash = (changed: typeof packet) => {
      const { sha256: _old, ...body } = changed;
      return { ...body, sha256: packetDigest(body) };
    };
    const checkedRestore = (changed: typeof packet) => {
      const candidate = rehash(changed);
      return restoreConnectedNativeStore({ ...input, packet: candidate, trustedSourceCaptureSha256: candidate.sha256 });
    };
    const before = await draftEffectCounts(target.owner);
    const targetFacts = async () => ({
      ledger: (await target.owner.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows,
      acl: (await target.owner.query(`SELECT proname,prosecdef,proacl::text,proconfig FROM pg_proc JOIN pg_namespace n ON n.oid=pronamespace
        WHERE n.nspname='public' AND proname IN ('catalog_order_acceptance_final','catalog_admission_owner_origin_guard',
          'catalog_admission_write_governed_draft','catalog_admission_runtime_checkout') ORDER BY proname`)).rows,
    });
    const installed = await targetFacts();
    const noConnect = { async connect() { throw new Error("Target connection was attempted"); } } as unknown as Pool;
    const rehashed = rehash({ ...packet, observation: { ...packet.observation, snapshot: "changed" } });
    for (const trustedSourceCaptureSha256 of [undefined, sourceCustody, "A".repeat(64)]) {
      await expect(restoreConnectedNativeStore({ ...input, owner: noConnect, packet: rehashed, trustedSourceCaptureSha256 }))
        .rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(restoreConnectedNativeStore({ ...input, owner: noConnect, packet: { ...packet, sha256: "a".repeat(64) } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    const sourceSchema = structuredClone(packet);
    sourceSchema.compatible.catalogueId = "a".repeat(64);
    await expect(checkedRestore(sourceSchema)).rejects.toMatchObject({ code: "schema_conflict" });
    const sized = structuredClone(packet);
    const subscription = sized.compatible.tables.find(table => table.table === "subscriptions")!;
    subscription.rows[0] = JSON.stringify({ ...JSON.parse(subscription.rows[0]!), configured_offer_version: "sized.v1" });
    await expect(checkedRestore(sized)).rejects.toMatchObject({ code: "unsupported_table", table: "subscriptions" });
    const oversized = structuredClone(packet);
    const receipts = oversized.owned.find(table => table.table === "commerce_order_draft_receipts")!;
    receipts.rows = Array<string>(10_001).fill(receipts.rows[0]!);
    await expect(checkedRestore(oversized)).rejects.toMatchObject({ code: "limit_exceeded" });

    const badPublication = structuredClone(packet);
    const publications = badPublication.owned.find(table => table.table === "catalog_publications")!;
    publications.rows[0] = JSON.stringify({ ...JSON.parse(publications.rows[0]!), canonical_state: "{}" });
    const malformed = rehash(badPublication);
    await expect(restoreConnectedNativeStore({ ...input, owner: noConnect, packet: malformed, trustedSourceCaptureSha256: malformed.sha256 }))
      .rejects.toMatchObject({ code: "target_conflict", cause: expect.anything() });
    const fakeCensus = { table: "commerce_orders", name: "unknown_insert_guard" };
    let censusHits = 0;
    const withUnknownTrigger = { async connect() {
      const client = await target.owner.connect();
      return {
        async query(sql: string | QueryConfig, values?: unknown[]) {
          const result = typeof sql === "string" ? await client.query(sql, values) : await client.query(sql);
          const text = typeof sql === "string" ? sql : sql.text;
          if (text.includes("t.tgname AS name FROM pg_catalog.pg_trigger")) {
            censusHits++;
            result.rows.push(fakeCensus);
          }
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      };
    } } as unknown as Pool;
    for (const gate of ["privacy", "columns"] as const) {
      const changed = structuredClone(packet);
      if (gate === "privacy") changed.requiredPrivacyContributorIds = [...changed.requiredPrivacyContributorIds, "synthetic-extra"].sort();
      else changed.owned.find(table => table.table === "commerce_order_draft_receipts")!.columns[0]!.type = "uuid";
      const candidate = rehash(changed);
      await expect(restoreConnectedNativeStore({ ...input, owner: withUnknownTrigger, packet: candidate, trustedSourceCaptureSha256: candidate.sha256 }))
        .rejects.toMatchObject({ code: gate === "privacy" ? "target_conflict" : "schema_conflict" });
      expect(censusHits).toBe(0);
    }
    await expect(restoreConnectedNativeStore({ ...input, owner: withUnknownTrigger }))
      .rejects.toMatchObject({ code: "insert_trigger_requires_owner", table: "commerce_orders" });
    expect(censusHits).toBe(1);
    await target.owner.query("INSERT INTO public.commerce_settings(key,value_minor) VALUES('transfer_conflict',1)");
    await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "target_conflict" });
    await target.owner.query("DELETE FROM public.commerce_settings WHERE key='transfer_conflict'");
    const root = target.pools[0]!;
    await root.query("UPDATE public.platform_schema_migrations SET sha256=repeat('a',64) WHERE position=0");
    try { await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "schema_conflict" }); }
    finally { await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [installed.ledger[0]!.sha256]); }

    // Only this source fixture can record a damaged reverse receipt. Re-enable
    // both definitions before capture so the target sees the installed graph.
    const mutation = await source.owner.connect();
    try {
      await mutation.query("BEGIN");
      await mutation.query(`ALTER TABLE public.commerce_order_draft_receipts DISABLE TRIGGER commerce_order_draft_receipts_catalog_owner_origin_guard;
        ALTER TABLE public.commerce_order_draft_receipts DISABLE TRIGGER commerce_order_draft_receipts_catalog_final`);
      expect((await mutation.query("UPDATE public.commerce_order_draft_receipts SET request_fingerprint=repeat('a',32) WHERE order_id=$1", [governed.id])).rowCount).toBe(1);
      await mutation.query(`ALTER TABLE public.commerce_order_draft_receipts ENABLE TRIGGER commerce_order_draft_receipts_catalog_final;
        ALTER TABLE public.commerce_order_draft_receipts ENABLE TRIGGER commerce_order_draft_receipts_catalog_owner_origin_guard`);
      await mutation.query("COMMIT");
    } finally {
      await mutation.query("ROLLBACK");
      mutation.release();
    }
    const damaged = await captureRestrictedStore(source, "governed-damaged");
    const damagedSourceCustody = damaged.sha256;
    const remedy = "Ask the source installation owner to verify the stamped draft and its companions, then recapture the source and retry on the verified target.";
    await expect(restoreConnectedNativeStore({ ...input, packet: damaged, trustedSourceCaptureSha256: damagedSourceCustody }))
      .rejects.toMatchObject({ code: "target_conflict", name: "PostgresTransferError", message: "postgres_transfer_target_conflict", remedy });
    expect(await draftEffectCounts(target.owner)).toEqual(before);
    expect(await targetFacts()).toEqual(installed);

    await expect(restoreConnectedNativeStore(input)).resolves.toMatchObject({ captureSha256: sourceCustody, replayed: false });
    const retained = await captureRestrictedStore(target, "governed-restored");
    expect(retained.owned).toEqual(packet.owned);
    expect(retained.compatible.tables).toEqual(packet.compatible.tables);
    expect((await target.owner.query(`SELECT count(*) FILTER (WHERE metadata ? 'catalogAdmissionOwnerOrigin')::integer AS stamped,
      count(*) FILTER (WHERE NOT metadata ? 'catalogAdmissionOwnerOrigin')::integer AS historical FROM public.commerce_orders`)).rows)
      .toEqual([{ stamped: 1, historical: 1 }]);
    await expect(restoreConnectedNativeStore({ ...input, trustedSourceCaptureSha256: undefined })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(restoreConnectedNativeStore({ ...input, packet: rehashed })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(restoreConnectedNativeStore(input)).resolves.toMatchObject({ captureSha256: sourceCustody, replayed: true });
    expect(await targetFacts()).toEqual(installed);
  } finally {
    await Promise.all([source, target].map(store => closePostgres(store.container, store.pools)));
  }
}, postgresSetupTimeoutMs);
