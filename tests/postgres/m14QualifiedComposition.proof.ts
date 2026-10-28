// One disposable installation's production proof; invoked only by its adjacent test.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createPostgresFulfillmentDispatchStore, createPostgresFulfillmentShipmentSpinePort } from "@openlup/platform/fulfillment";
import type { FulfillmentObservation } from "@openlup/platform/fulfillment/contracts";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { createPostgresNotificationRecipientsPort } from "@openlup/platform/communications";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { createPostgresAccountLinkStore, createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork } from "@openlup/platform/identity";
import type { ErasureReceipt } from "@openlup/platform/identity/contracts";
import { createCustomerDiagnosticHistoryPort } from "../../server/adapters/customerDiagnosticHistory.js";
import { createPostgresCustomerDiagnosticHistoryTransactionLane } from "../../server/adapters/postgres/dataGateway.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { createPostgresFulfillmentObservationLifecycle } from "../../server/adapters/postgres/fulfillmentObservationLifecycle.js";
import { qualifiedPostgresCatalogPayload, qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { fixture, openCase } from "../helpers/fulfillmentNative.js";

const input: { connectionString: string; selection: QualifiedPostgresInstallation; expectedInventory: string;
  discriminators: boolean } = JSON.parse(process.argv[2]!);
const { selection } = input;
const lockName = "openlup:public-platform-migrations:v1";
const password = "synthetic-proof-only";
const pools: Pool[] = [];
const ports: { close(): Promise<void> }[] = [];
const pool = (url: string): Pool => { const value = new Pool({ connectionString: url }); pools.push(value); return value; };
const loginUrl = (name: string, secret = password): string => {
  const url = new URL(input.connectionString); url.username = name; url.password = secret; return url.toString();
};
// Every identifier below is from the fixed synthetic profiles, not database input.
const identifier = (value: string): string => {
  assert.match(value, /^[a-z_][a-z0-9_]*$/u); return `"${value}"`;
};
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

async function proveRetainedRuntime(admin: Pool) {
  assert.ok(selection.restoreLogin);
  const runtime = pool(loginUrl(selection.runtimeLogin));
  const restore = pool(loginUrl(selection.restoreLogin));
  for (const [actor, name] of [[runtime, selection.runtimeLogin], [restore, selection.restoreLogin]] as const) {
    assert.deepEqual((await actor.query("SELECT current_user,session_user")).rows, [{ current_user: name, session_user: name }]);
  }
  // These writes use the installed R grants and RLS, never an installer pool.
  const ordinary = (await runtime.query("INSERT INTO public.clients(email,lifecycle_stage) VALUES($1,'lead') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0].id;
  await runtime.query("UPDATE public.clients SET first_name='runtime update' WHERE id=$1", [ordinary]);
  assert.deepEqual((await admin.query("SELECT from_stage,to_stage FROM public.customer_subject_lifecycle_events WHERE client_id=$1", [ordinary])).rows,
    [{ from_stage: null, to_stage: "lead" }]);
  assert.equal((await runtime.query("SELECT first_name FROM public.clients WHERE id=$1", [ordinary])).rows[0].first_name, "runtime update");
  const normal = await fixture(admin);
  await openCase(admin, normal);
  await assert.rejects(runtime.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')", [normal.subscription]), /alignment_protected/u);
  await admin.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)", [
    `arrival-${normal.shipment}`, normal.shipment, "2026-09-07T12:00:00.111222Z", `evidence:${normal.shipment}`,
  ]);
  const normalAt = (await admin.query("SELECT next_cycle_at::text AS at FROM public.subscriptions WHERE id=$1", [normal.subscription])).rows[0].at;
  assert.equal((await runtime.query("SELECT public.subscription_delivery_alignment_admit_renewal($1,$2,$3) AS response", [normal.subscription, normalAt, "2026-10-21T12:00:00Z"])).rows[0].response.allowed, true);
  const normalInsert = () => runtime.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')", [normal.subscription, normalAt]);
  await normalInsert();
  await assert.rejects(normalInsert, /admission_required/u);
  assert.deepEqual((await admin.query("SELECT consumed_at IS NOT NULL AS consumed FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1", [normal.subscription])).rows, [{ consumed: true }]);

  const clientRow = [randomUUID(), "2020-01-02T03:04:05.123456Z", "2021-02-03T04:05:06.654321Z", `${randomUUID()}@example.invalid`,
    "First distinct", "Last distinct", "+123456789", "fixture-country", "customer", "historical-channel", "external-distinct",
    '{"integer":9007199254740993,"nested":{"a":[null,true,"value"]}}', randomUUID()];
  const clientSql = "SELECT public.client_import_retained_row($1::uuid,$2::timestamptz,$3::timestamptz,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::jsonb,$13::uuid) AS inserted";
  const cycleSql = "SELECT public.subscription_cycle_import_retained_row($1::uuid,$2::uuid,$3::timestamptz,$4::text,$5::timestamptz,$6::timestamptz,$7::uuid,$8::text) AS inserted";
  assert.equal((await restore.query(clientSql, clientRow)).rows[0].inserted, true);
  assert.deepEqual((await admin.query(`SELECT to_jsonb(c)=jsonb_build_object('id',$1::uuid,'created_at',$2::timestamptz,'updated_at',$3::timestamptz,
    'email',$4::text,'first_name',$5::text,'last_name',$6::text,'phone',$7::text,'country',$8::text,'lifecycle_stage',$9::text,
    'acquisition_source',$10::text,'external_ref',$11::text,'metadata',$12::jsonb,'principal_id',$13::uuid) AS identical
    FROM public.clients c WHERE c.id=$1`, clientRow)).rows, [{ identical: true }]);
  assert.deepEqual((await admin.query("SELECT id FROM public.customer_subject_lifecycle_events WHERE client_id=$1", [clientRow[0]])).rows, []);
  await admin.query("INSERT INTO public.customer_subject_lifecycle_events(id,client_id,from_stage,to_stage,occurred_at) VALUES($1,$2,'lead','customer','2019-04-05T06:07:08.987654Z')", [randomUUID(), clientRow[0]]);
  const history = async () => (await admin.query("SELECT to_jsonb(e)::text AS value FROM public.customer_subject_lifecycle_events e WHERE client_id=$1", [clientRow[0]])).rows;
  const retainedHistory = await history();
  assert.equal((await restore.query(clientSql, clientRow)).rows[0].inserted, false);
  const changedClient = [...clientRow]; changedClient[5] = "different last name";
  await assert.rejects(restore.query(clientSql, changedClient), { code: "23505", message: "client_retained_row_conflict" });
  assert.deepEqual(await history(), retainedHistory);

  // Installation fixtures seed referenced parents; S imports only the declared
  // retained rows. Compare text/JSON in PostgreSQL to preserve bigint precision.
  const retained = await fixture(admin);
  const alignment = await openCase(admin, retained);
  await admin.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)", [
    `arrival-${retained.shipment}`, retained.shipment, "2026-09-07T12:00:00.111222Z", `evidence:${retained.shipment}`,
  ]);
  const at = (await admin.query("SELECT next_cycle_at::text AS at FROM public.subscriptions WHERE id=$1", [retained.subscription])).rows[0].at;
  assert.equal((await runtime.query("SELECT public.subscription_delivery_alignment_admit_renewal($1,$2,$3) AS response", [retained.subscription, at, "2026-10-21T12:00:00Z"])).rows[0].response.allowed, true);
  await admin.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','fixture-stock','fixture-channel','2020-01-02T03:04:05.123456Z','authorization-distinct')`, [retained.subscription]);
  await admin.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'fixture-sku',2,9007199254740993)", [retained.subscription]);
  const operation = randomUUID();
  await admin.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,claim_token,claim_generation,claimed_by,claimed_at,lease_expires_at)
    VALUES($1,$2,$3,2,$4,$5,'{"amount":9007199254740993}',$6,9007199254740993,'fixture','2026-10-01','2026-11-01')`,
  [operation, retained.subscription, at, `subscription:${retained.subscription}:cycle:${at}`, "b".repeat(64), randomUUID()]);
  const cycleRow = [randomUUID(), retained.subscription, at, "payment_pending", "2022-03-04T05:06:07.333444Z", "2023-04-05T06:07:08.555666Z", operation, "b".repeat(64)];
  const frozen = async () => (await admin.query(`SELECT jsonb_build_object(
    'subscription',(SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=$1),
    'terms',(SELECT to_jsonb(t) FROM public.subscription_renewal_terms t WHERE subscription_id=$1),
    'termLines',(SELECT jsonb_agg(t ORDER BY line_ordinal) FROM public.subscription_renewal_term_lines t WHERE subscription_id=$1),
    'operation',(SELECT to_jsonb(o) FROM public.subscription_renewal_operations o WHERE id=$2),
    'case',(SELECT to_jsonb(c) FROM public.subscription_delivery_alignment_cases c WHERE id=$3),
    'receipts',(SELECT jsonb_agg(r ORDER BY id) FROM public.subscription_delivery_alignment_admission_receipts r WHERE subscription_id=$1))::text AS value`,
  [retained.subscription, operation, alignment.id])).rows[0].value;
  const frozenBefore = await frozen();
  await assert.rejects(runtime.query("SELECT public.subscription_delivery_alignment_set_mode($1)", ["off"]), { code: "42501" });
  for (const mode of ["off", "shadow", "protect", "auto_align"]) {
    await admin.query("SELECT public.subscription_delivery_alignment_set_mode($1)", [mode]);
    assert.equal((await restore.query(cycleSql, cycleRow)).rows[0].inserted, mode === "off");
    assert.equal(await frozen(), frozenBefore);
  }
  assert.deepEqual((await admin.query(`SELECT to_jsonb(c)=jsonb_build_object('id',$1::uuid,'subscription_id',$2::uuid,'scheduled_at',$3::timestamptz,
    'status',$4::text,'created_at',$5::timestamptz,'updated_at',$6::timestamptz,'renewal_operation_id',$7::uuid,'renewal_operation_fingerprint',$8::text) AS identical
    FROM public.subscription_cycles c WHERE c.id=$1`, cycleRow)).rows, [{ identical: true }]);
  const changedCycle = [...cycleRow]; changedCycle[3] = "cancelled";
  await assert.rejects(restore.query(cycleSql, changedCycle), { code: "23505", message: "subscription_cycle_retained_row_conflict" });
  assert.equal(await frozen(), frozenBefore);
  assert.deepEqual((await admin.query(`SELECT tgname,tgenabled FROM pg_catalog.pg_trigger
    WHERE tgrelid IN ('public.clients'::regclass,'public.subscription_cycles'::regclass) AND NOT tgisinternal ORDER BY tgname`)).rows, [
    { tgname: "customer_subject_capture_lifecycle_trigger", tgenabled: "O" },
    { tgname: "trg_subscription_delivery_alignment_guard_cycle_insert", tgenabled: "O" },
  ]);
  for (const sql of ["SET ROLE openlup_retained_import_owner", "SET SESSION AUTHORIZATION openlup_retained_import_owner",
    "INSERT INTO public.clients(email) VALUES('denied@example.invalid')", "SELECT * FROM public.clients", "CREATE TABLE public.import_escape(id integer)"]) {
    await assert.rejects(restore.query(sql), { code: "42501" });
  }
  await runtime.query("SELECT set_config('openlup.qualified.restore_login',$1,false)", [selection.runtimeLogin]);
  try {
    await assert.rejects(runtime.query(clientSql, clientRow), { code: "42501" });
    await assert.rejects(runtime.query(cycleSql, cycleRow), { code: "42501" });
    await assert.rejects(runtime.query("SET ROLE openlup_retained_import_owner"), { code: "42501" });
  } finally { await runtime.query("RESET openlup.qualified.restore_login"); }
  const actor = await restore.connect();
  try {
    await assert.rejects(actor.query("SET session_replication_role=replica"), { code: "42501" });
    await admin.query(`GRANT SET ON PARAMETER session_replication_role TO ${identifier(selection.restoreLogin)}`);
    for (const mode of ["replica", "local"]) for (const [sql, values] of [[clientSql, clientRow], [cycleSql, cycleRow]] as const) {
      await actor.query("BEGIN");
      try {
        await actor.query("SELECT pg_catalog.set_config('session_replication_role',$1,true)", [mode]);
        await assert.rejects(actor.query(sql, values), { code: "55000", message: "retained_import_requires_origin" });
      } finally { await actor.query("ROLLBACK"); }
    }
  } finally {
    await admin.query(`REVOKE SET ON PARAMETER session_replication_role FROM ${identifier(selection.restoreLogin)}`);
    actor.release();
  }
  assert.deepEqual(await history(), retainedHistory);
  assert.equal(await frozen(), frozenBefore);
}

async function proveObservationRuntime(bootstrap: Pool): Promise<void> {
  const runtime = pool(loginUrl(selection.runtimeLogin));
  const identity = await runtime.query(`SELECT current_user,session_user,rolsuper,rolbypassrls,
    pg_catalog.pg_get_userbyid(c.relowner)<>current_user AS nonowner
    FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
    WHERE r.rolname=current_user AND c.oid='public.fulfillment_dispatch_refs'::regclass`);
  assert.deepEqual(identity.rows, [{ current_user: selection.runtimeLogin, session_user: selection.runtimeLogin,
    rolsuper: false, rolbypassrls: false, nonowner: true }]);
  const f = await fixture(bootstrap);
  const revision = { schemaVersion: 1, source: "qualified-native", revision: 1 };
  const evidence = { commandFingerprint: "c".repeat(64), contactRevision: revision,
    providerRef: "warehouse-a", carrierRef: null, serviceRef: null };
  // Setup includes the already-submitted request whose acknowledgement was
  // lost. The G1 recovery operations themselves use only the actual R login.
  await bootstrap.query("INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref) VALUES($1,$2,'warehouse-a')", [f.shipment, revision]);
  const setup = createPostgresFulfillmentDispatchStore(bootstrap, {
    prepare: async () => ({ disposition: "ready", contactRevision: 1 }), readCandidate: async () => null,
  });
  const claimed = await setup.claim({ requestKey: `qualified-g1:${f.shipment}`, fulfillmentRef: f.shipment,
    orderRef: f.order, parcelRef: null, mode: "live", evidence });
  assert.equal(claimed.kind, "claimed"); if (claimed.kind !== "claimed") throw new Error("qualified G1 fixture refused");
  await setup.begin({ dispatchRef: claimed.record.dispatchRef, commandFingerprint: evidence.commandFingerprint });
  const native = createPostgresFulfillmentDispatchStore(runtime, {
    prepare: async () => ({ disposition: "ready", contactRevision: 1 }), readCandidate: async () => null,
  });
  assert.equal((await native.read(`qualified-g1:${f.shipment}`))!.externalRef, null);
  const externalRef = `external-${randomUUID()}`;
  const observation: FulfillmentObservation = { eventKey: `qualified-g1:${f.shipment}`, eventKind: "shipment.accepted",
    firstReceivedAt: "2026-10-28T07:00:00Z", trackingRefs: [],
    correlation: { fulfillmentRef: f.shipment, orderRef: f.order, externalRef, parcelRef: null, orderNumber: null, providerFulfillmentRef: null },
    fact: { schemaVersion: 1, mapperVersion: "synthetic-v1", factId: `accepted:${f.shipment}`, providerKind: "warehouse-a",
      fulfillmentReference: externalRef, canonicalStatus: "provider_received", occurredAt: "2026-10-28T06:59:00Z", receivedAt: "2026-10-28T07:00:00Z",
      provenance: { source: "provider_webhook", authority: "provider_asserted" },
      rawEvent: { reference: `evidence:${randomUUID()}`, digestAlgorithm: "sha256", digest: "d".repeat(64) } } };
  const spine = createPostgresFulfillmentShipmentSpinePort(runtime, { portKey: "fixture-port" });
  const keys = { providerAttemptKey: `qualified-accepted:${f.shipment}`, labelKey: `qualified-receipt:${f.shipment}` };
  const lifecycle = () => createPostgresFulfillmentObservationLifecycle(runtime, { providerRef: "warehouse-a", acceptanceKeys: () => keys });
  await spine.localPersistence.recordObservation(observation);
  const ref = await lifecycle().findDispatchRef(observation); assert(ref);
  await lifecycle().acknowledgeDispatchAcceptance(ref, observation);
  await spine.localPersistence.recordStatusEvidence(ref, observation);
  await spine.localPersistence.markProcessed(observation.eventKey, { status: "processed" });
  const before = await native.read(`qualified-g1:${f.shipment}`);
  assert.equal(before!.status, "created"); assert.equal(before!.externalRef, externalRef);
  await lifecycle().acknowledgeDispatchAcceptance((await lifecycle().findDispatchRef(observation))!, observation);
  assert.deepEqual(await native.read(`qualified-g1:${f.shipment}`), before);
  assert.deepEqual((await runtime.query("SELECT external_id FROM public.shipment_external_refs WHERE shipment_id=$1 AND ref_role='dispatch'", [f.shipment])).rows, [{ external_id: externalRef }]);
  assert.deepEqual((await runtime.query("SELECT count(*)::integer AS count FROM public.fulfillment_provider_attempts WHERE attempt_key=$1", [keys.providerAttemptKey])).rows, [{ count: 1 }]);
  await assert.rejects(lifecycle().findDispatchRef({ ...observation, correlation: { ...observation.correlation, externalRef: `external-${randomUUID()}` } }), /correlation_conflict/u);
  assert.deepEqual(await native.read(`qualified-g1:${f.shipment}`), before);
  assert.deepEqual((await runtime.query("SELECT current_user,session_user")).rows,
    [{ current_user: selection.runtimeLogin, session_user: selection.runtimeLogin }]);
}

async function proveRuntimeLockPrivileges(bootstrap: Pool): Promise<void> {
  const operator = "e2000000-0000-4000-8000-000000000001";
  const subject = "e2000000-0000-4000-8000-000000000002";
  const eventKey = "e2000000-0000-4000-8000-000000000003";
  const receiptId = "e2000000-0000-4000-8000-000000000004";
  const key = "e2000000-0000-4000-8000-000000000005";
  const differentEventId = "e2000000-0000-4000-8000-000000000006";
  const env = { connectionString: loginUrl(selection.runtimeLogin) };
  const runtime = pool(env.connectionString);
  const tables = ["public.platform_communication_operators", "public.customer_diagnostic_events", "public.identity_privacy_erasures"];
  const assertRuntime = async (db: PgQueryExecutor): Promise<void> => {
    assert.deepEqual((await db.query(`SELECT current_user AS runtime, session_user AS session,
      r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = ANY($1::pg_catalog.regclass[])
        AND (c.relowner = r.oid OR pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE'))) AS nonowner
      FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`, [tables])).rows,
    [{ runtime: selection.runtimeLogin, session: selection.runtimeLogin, superuser: false, bypass_rls: false, nonowner: true }]);
  };
  await assertRuntime(runtime);
  await bootstrap.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'lock-admin@example.invalid'),($2,'lock-subject@example.invalid')", [operator, subject]);
  await bootstrap.query(`INSERT INTO public.platform_human_memberships
    (principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES ($1,'admin','active','legacy',clock_timestamp())`, [operator]);
  await bootstrap.query(`INSERT INTO public.platform_communication_operators(principal_id,created_at,updated_at)
    VALUES ($1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, [operator]);

  // The real admission query locks the seeded operator and membership FOR SHARE.
  const notifications = createPostgresNotificationRecipientsPort(env, { operatorId: operator, poolFactory: () => runtime });
  ports.push(notifications);
  assert.deepEqual(await notifications.listNotificationRecipients({ notification_type: "new_signup" }), { recipients: [] });
  assert.deepEqual((await runtime.query(`SELECT attname FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.platform_communication_operators'::pg_catalog.regclass AND attnum > 0 AND NOT attisdropped
      AND pg_catalog.has_column_privilege(current_user,attrelid,attnum,'UPDATE') ORDER BY attname`)).rows, [{ attname: "updated_at" }]);
  const updated = await runtime.query(`UPDATE public.platform_communication_operators
    SET updated_at = '2026-01-02T00:00:00Z' WHERE principal_id = $1 RETURNING updated_at`, [operator]);
  assert.equal(updated.rowCount, 1);
  assert.equal(updated.rows[0].updated_at.toISOString(), "2026-01-02T00:00:00.000Z");
  const operatorBefore = (await runtime.query("SELECT * FROM public.platform_communication_operators WHERE principal_id=$1", [operator])).rows;
  await assert.rejects(runtime.query("UPDATE public.platform_communication_operators SET active=false WHERE principal_id=$1 RETURNING principal_id", [operator]), { code: "42501" });
  assert.deepEqual((await runtime.query("SELECT * FROM public.platform_communication_operators WHERE principal_id=$1", [operator])).rows, operatorBefore);

  const lane = createPostgresCustomerDiagnosticHistoryTransactionLane(env);
  ports.push(lane);
  const observation = {
    contractVersion: "customer-diagnostic-ingest.v1" as const, coverageVersion: "purchase-auth-account.v2" as const,
    clientEventKey: eventKey, action: "entry_boot" as const, phase: "settled" as const, code: "failed" as const,
    presentedCredentialHash: null, issuedCredentialHash: digest("q2-lock-credential"), principalId: null, subjectId: null,
    ingestRequestId: "q2:lock-proof", abuseKeyHash: digest("q2-lock-abuse"), payloadFingerprint: digest("q2-lock-payload"),
  };
  const ingest = (presentedCredentialHash: string | null) => lane.run(async gateway => {
    await assertRuntime(gateway as PgQueryExecutor);
    return createCustomerDiagnosticHistoryPort(gateway, 7).ingest({ ...observation, presentedCredentialHash });
  });
  const first = await ingest(null);
  assert.equal(first.outcome, "committed");
  assert.equal(first.deduplicated, false);
  assert.ok(first.segmentId);
  const replay = await ingest(observation.issuedCredentialHash);
  assert.deepEqual(replay, { ...first, credentialDisposition: "reused", deduplicated: true });
  const eventBefore = (await runtime.query("SELECT * FROM public.customer_diagnostic_events WHERE segment_id=$1 AND client_event_key=$2", [first.segmentId, eventKey])).rows;
  assert.equal(eventBefore.length, 1);
  // Autocommit denials leave the next operation's transaction usable.
  await assert.rejects(runtime.query("UPDATE public.customer_diagnostic_events SET id=$2 WHERE id=$1 RETURNING id", [eventBefore[0].id, differentEventId]), { code: "42501" });
  assert.deepEqual((await runtime.query("SELECT * FROM public.customer_diagnostic_events WHERE segment_id=$1 AND client_event_key=$2", [first.segmentId, eventKey])).rows, eventBefore);

  const privacy = createPostgresPrivacyStore();
  const privacyUnitOfWork = createPostgresPrivacyUnitOfWork(env);
  ports.push(privacyUnitOfWork);
  const receipt: ErasureReceipt = { version: "identity.erasure.v1", erasureId: receiptId, completedAt: "2026-01-03T00:00:00.000Z", outcome: "ERASED", obligations: [] };
  await privacyUnitOfWork.run(async db => {
    await assertRuntime(db);
    await privacy.prepareErasure(db);
    assert.deepEqual((await db.query(`SELECT mode FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND relation='public.identity_privacy_erasures'::pg_catalog.regclass AND mode='ShareRowExclusiveLock' AND granted`)).rows, [{ mode: "ShareRowExclusiveLock" }]);
    await privacy.saveReceipt(db, { principalId: subject, contactId: null, identity: {} }, { principalId: operator }, key, receipt, []);
    assert.deepEqual(await privacy.findReceipt(db, { kind: "principal", principalId: subject }, key), receipt);
  });
  const receiptBefore = (await runtime.query("SELECT * FROM public.identity_privacy_erasures WHERE erasure_id=$1", [receiptId])).rows;
  assert.equal(receiptBefore.length, 1);
  const accounts = createPostgresAccountLinkStore(env);
  ports.push(accounts);
  // Reaching this semantic refusal proves the production SHARE lock and receipt read succeeded.
  await assert.rejects(accounts.createAccount({ email: "lock-subject@example.invalid", principalId: subject, acquisitionSource: "direct", lifecycleStage: "lead" }), /account_erased_refused/u);
  await assert.rejects(runtime.query(`UPDATE public.identity_privacy_erasures
    SET completed_at='2026-01-04T00:00:00Z' WHERE erasure_id=$1 RETURNING erasure_id`, [receiptId]), { code: "42501" });
  assert.deepEqual((await runtime.query("SELECT * FROM public.identity_privacy_erasures WHERE erasure_id=$1", [receiptId])).rows, receiptBefore);
  await assertRuntime(runtime);
}

async function prove() {
  const started = performance.now();
  const fixtureUrl = new URL(input.connectionString);
  assert.equal(fixtureUrl.hostname, "127.0.0.1");
  assert.ok(fixtureUrl.port);
  assert.equal(fixtureUrl.username, "postgres");
  assert.equal(fixtureUrl.password, "synthetic-conformance");
  assert.equal(fixtureUrl.pathname, "/postgres");
  assert.equal(fixtureUrl.search, "");
  assert.match(import.meta.resolve("@openlup/platform/migrations"), /\/dist\/migrations\/index\.js$/u);
  const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", {
    migrationIsBootstrap: selection.migrationLogin === selection.bootstrapLogin, hasRestore: selection.restoreLogin !== undefined,
  });
  assert.equal(manifest.objectInventorySha256, input.expectedInventory);
  const expected = [manifest.baseline, ...manifest.forward];
  assert.equal(expected.length, 90);
  for (const entry of expected) assert.equal(digest(readFileSync(entry.file, "utf8")), entry.sha256);
  const { restoreLogin: _restoreLogin, ...withoutRestore } = selection;
  await assert.rejects(createPostgresMigrationRunner({ connectionString: input.connectionString }, { installation: withoutRestore }).status(),
    /qualified retained import requires an explicit restore login binding/u);

  // Rename OID 10 through a temporary setup login: both reference and target
  // then use their actual declared names, including the aliased M/bootstrap shape.
  const original = pool(input.connectionString);
  await original.query(`CREATE ROLE q2_fixture_setup LOGIN SUPERUSER PASSWORD '${password}'`);
  const setup = pool(loginUrl("q2_fixture_setup"));
  await setup.query(`ALTER ROLE postgres RENAME TO ${identifier(selection.bootstrapLogin)}`);
  await original.end();
  await setup.end();
  const bootstrap = pool(loginUrl(selection.bootstrapLogin, "synthetic-conformance"));
  await bootstrap.query("DROP ROLE q2_fixture_setup");
  if (selection.migrationLogin !== selection.bootstrapLogin) {
    await bootstrap.query(`CREATE ROLE ${identifier(selection.migrationLogin)} LOGIN INHERIT SUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await bootstrap.query(`ALTER DATABASE postgres OWNER TO ${identifier(selection.migrationLogin)}`);
  }
  for (const name of [selection.runtimeLogin, ...(selection.restoreLogin === undefined ? [] : [selection.restoreLogin])]) {
    await bootstrap.query(`CREATE ROLE ${identifier(name)} LOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  }
  if (selection.roleMode === "operator-provisioned") {
    for (const name of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
      await bootstrap.query(`CREATE ROLE ${identifier(name)} NOLOGIN NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    }
    for (const name of ["anon", "authenticated", "service_role", "platform_acquisition_runtime"]) {
      await bootstrap.query(`GRANT ${identifier(name)} TO ${identifier(selection.runtimeLogin)}
        WITH ADMIN FALSE, INHERIT ${name === "service_role" ? "TRUE" : "FALSE"}, SET TRUE`);
    }
  }
  const connectionString = loginUrl(selection.migrationLogin,
    selection.migrationLogin === selection.bootstrapLogin ? "synthetic-conformance" : password);
  const runner = createPostgresMigrationRunner({ connectionString }, { installation: selection });
  const before = await runner.status();
  assert.deepEqual(before, { applied: [], pending: expected.map(entry => entry.file) });
  const appliedNow = await runner.apply();
  assert.deepEqual(appliedNow, { applied: expected.map(entry => entry.file) });
  const ledger = async () => (await bootstrap.query("SELECT catalog_path,sha256,position,executed_at::pg_catalog.text FROM public.platform_schema_migrations ORDER BY position")).rows;
  const installed = await ledger();
  assert.deepEqual(installed.map(({ executed_at: _time, ...row }) => row), expected.map((entry, position) => ({ catalog_path: entry.file, sha256: entry.sha256, position })));
  const healthy = { applied: expected.map(entry => entry.file), pending: [] };
  const after = await runner.status();
  assert.deepEqual(after, healthy);
  const replay = await runner.apply();
  assert.deepEqual(replay, { applied: [] });
  assert.deepEqual(await ledger(), installed);
  // Observe the actual production payload independently under its real session
  // lock. This is a measured result compared to the prior pin, never an override.
  const observerUrl = new URL(connectionString);
  observerUrl.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
  const observer = pool(observerUrl.toString());
  const client = await observer.connect();
  let inventorySha256: string;
  try {
    assert.deepEqual((await client.query("SELECT current_user AS migration, session_user AS session")).rows,
      [{ migration: selection.migrationLogin, session: selection.migrationLogin }]);
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lockName]);
    inventorySha256 = digest(await qualifiedPostgresCatalogPayload(client, selection, lockName));
    assert.equal(inventorySha256, input.expectedInventory);
  } finally {
    await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))", [lockName]);
    client.release();
  }
  await proveRetainedRuntime(bootstrap);
  await proveRuntimeLockPrivileges(bootstrap);
  if (input.discriminators) await proveObservationRuntime(bootstrap);
  assert.deepEqual(await runner.status(), healthy);
  assert.deepEqual(await ledger(), installed);
  if (input.discriminators) {
    const originalComment = (await bootstrap.query("SELECT pg_catalog.col_description('public.clients'::pg_catalog.regclass,attnum) AS comment FROM pg_catalog.pg_attribute WHERE attrelid='public.clients'::pg_catalog.regclass AND attname='email'")).rows[0].comment;
    await bootstrap.query("COMMENT ON COLUMN public.clients.email IS 'm14 qualification inventory mutant'");
    try {
      for (const operation of [() => runner.status(), () => runner.apply({ dryRun: true }), () => runner.apply()]) {
        await assert.rejects(operation, /platform migration inventory rejected: platform migration manifest: object inventory SHA-256 mismatch/u);
      }
      assert.deepEqual(await ledger(), installed);
    } finally {
      const restore = (await bootstrap.query("SELECT pg_catalog.format('COMMENT ON COLUMN public.clients.email IS %L',$1::pg_catalog.text) AS sql", [originalComment])).rows[0].sql;
      await bootstrap.query(restore);
    }
    assert.deepEqual(await runner.status(), healthy);

    // A separate session capability refusal, not the inventory mismatch above.
    await bootstrap.query("GRANT SET ON PARAMETER session_replication_role TO anon");
    try {
      for (const operation of [() => runner.status(), () => runner.apply({ dryRun: true }), () => runner.apply()]) {
        await assert.rejects(operation, /qualified PostgreSQL installation refused: runtime_ddl_or_replication_capability_unsafe/u);
      }
      assert.deepEqual(await ledger(), installed);
    } finally { await bootstrap.query("REVOKE SET ON PARAMETER session_replication_role FROM anon"); }
    assert.deepEqual(await runner.status(), healthy);

    // Exact public overloads can beat implicitly first pg_catalog candidates.
    // Their definitions intentionally change inventory; qualification must reach
    // that precise refusal without invoking either function, including pre-hook
    // lock acquisition/release and the catalog namespace filter.
    await bootstrap.query(`CREATE TABLE public.q2_shadow_calls(kind pg_catalog.text NOT NULL);
      CREATE FUNCTION public.left(value pg_catalog.name, size pg_catalog.int4)
        RETURNS pg_catalog.text LANGUAGE plpgsql VOLATILE AS $$
      BEGIN INSERT INTO public.q2_shadow_calls VALUES ('left'); RETURN pg_catalog.left(value::pg_catalog.text,size); END $$;
      CREATE FUNCTION public.hashtextextended(value pg_catalog.text, seed pg_catalog.int4)
        RETURNS pg_catalog.int8 LANGUAGE plpgsql VOLATILE AS $$
      BEGIN INSERT INTO public.q2_shadow_calls VALUES ('hashtextextended'); RETURN pg_catalog.hashtextextended(value,seed::pg_catalog.int8); END $$;`);
    try {
      for (const operation of [() => runner.status(), () => runner.apply({ dryRun: true }), () => runner.apply()]) {
        await assert.rejects(operation, /platform migration inventory rejected: platform migration manifest: object inventory SHA-256 mismatch/u);
      }
      assert.deepEqual((await bootstrap.query("SELECT kind FROM public.q2_shadow_calls")).rows, []);
      assert.deepEqual(await ledger(), installed);
    } finally {
      await bootstrap.query(`DROP FUNCTION public.left(pg_catalog.name,pg_catalog.int4);
        DROP FUNCTION public.hashtextextended(pg_catalog.text,pg_catalog.int4);
        DROP TABLE public.q2_shadow_calls`);
    }
    assert.deepEqual(await runner.status(), healthy);

    await bootstrap.query(`CREATE SCHEMA q2_shadow;
      CREATE TABLE q2_shadow.calls(kind pg_catalog.text NOT NULL);
      CREATE FUNCTION q2_shadow.current_database() RETURNS pg_catalog.name LANGUAGE plpgsql VOLATILE AS $$
      BEGIN INSERT INTO q2_shadow.calls VALUES ('current_database'); RETURN pg_catalog.current_database(); END $$;
      CREATE FUNCTION q2_shadow.pg_get_userbyid(value pg_catalog.oid) RETURNS pg_catalog.name LANGUAGE plpgsql VOLATILE AS $$
      BEGIN INSERT INTO q2_shadow.calls VALUES ('pg_get_userbyid'); RETURN pg_catalog.pg_get_userbyid(value); END $$;`);
    await bootstrap.query(`ALTER ROLE ${identifier(selection.migrationLogin)} IN DATABASE postgres SET search_path TO q2_shadow, pg_catalog, public`);
    try {
      const shadow = createPostgresMigrationRunner({ connectionString }, { installation: selection });
      for (const operation of [() => shadow.status(), () => shadow.apply({ dryRun: true }), () => shadow.apply()]) {
        await assert.rejects(operation, /qualified PostgreSQL installation refused: qualified_profile_requires_canonical_search_path/u);
      }
      assert.deepEqual((await bootstrap.query("SELECT kind FROM q2_shadow.calls")).rows, []);
      assert.deepEqual(await ledger(), installed);
    } finally {
      await bootstrap.query(`ALTER ROLE ${identifier(selection.migrationLogin)} IN DATABASE postgres RESET search_path`);
      await bootstrap.query("DROP SCHEMA q2_shadow CASCADE");
    }
    const recovered = createPostgresMigrationRunner({ connectionString }, { installation: selection });
    assert.deepEqual(await recovered.status(), healthy);
    assert.deepEqual(await recovered.apply(), { applied: [] });
    assert.deepEqual(await ledger(), installed);
  }
  assert.deepEqual(await runner.status(), healthy);
  assert.deepEqual(await runner.apply(), { applied: [] });
  assert.deepEqual(await ledger(), installed);
  return { inventorySha256, ledgerRows: installed.length, pendingBefore: before.pending.length, appliedNow: appliedNow.applied.length,
    pendingAfter: after.pending.length, replayApplied: replay.applied.length, retainedRuntime: true, runtimeLockPrivilegesProved: true,
    nativeObservationRuntimeProved: input.discriminators,
    discriminators: input.discriminators, elapsedMs: Math.round(performance.now() - started) };
}

let exitCode = 0;
try {
  const result = await prove();
  await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(result)}\n`, error => error ? reject(error) : resolve()));
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  const closedPorts = await Promise.allSettled(ports.map(value => value.close()));
  if (closedPorts.some(result => result.status === "rejected")) exitCode = 1;
  const closing = await Promise.allSettled(pools.filter(value => !value.ended).map(value => value.end()));
  if (closing.some(result => result.status === "rejected")) exitCode = 1;
}
// Every runner call is awaited; exiting releases only this child's hidden pools.
process.exit(exitCode);
