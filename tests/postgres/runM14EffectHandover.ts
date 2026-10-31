// Explicit, one-shot local conformance witness, not a serving runtime or a new
// required job. Run only in its authorized resource slot with an existing local
// immutable Node24.21.0 image and this worktree's built dependencies.
// Source preparation: requires landed canonical91 plus the separately integrated
// connected capture/restore APIs. No physical clone or owner runtime fallback.
import assert from "node:assert/strict";
import { readProcessEnvironment } from "../../server/_lib/observability/runtimeProvenance.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, TypeOverrides } from "pg";
import { createPostgresGatewayTypeOverrides } from "@openlup/platform/data";
import { createPostgresOrderReviewMediaPort } from "@openlup/platform/commerce/server";
import { createPostgresDeliveryAlignmentPort, createPostgresFulfillmentDispatchStore, createPostgresFulfillmentShipmentSpinePort, runFulfillmentDispatchWorker } from "@openlup/platform/fulfillment";
import type { FulfillmentDispatchRequest, FulfillmentObservation } from "@openlup/platform/fulfillment/contracts";
import { verifyHmacSignature } from "@openlup/platform/http";
import { createPostgresFulfillmentObservationLifecycle } from "../../server/adapters/postgres/fulfillmentObservationLifecycle.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresStartupOptions, qualifiedPostgresStartupOptions, type QualifiedAdminPostgresInstallation, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
// These canonical APIs belong to the transfer predecessor; do not copy their
// unpublished implementation or substitute physical dump/restore here.
import { captureConnectedNativeStore, connectedNativeStoreTables } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferInventory.js";
import { createOrderReviewMediaTransferReader } from "../../server/adapters/filesystem/orderReviewMediaTransferReader.js";
import { stageOrderReviewMediaFilesystem, restoreOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferRestore.js";
import { OrderReviewMediaObjectStore } from "../../server/adapters/filesystem/orderReviewMediaObjectStore.js";
import { resolveOrderReviewRuntimeBinding, type OrderReviewRuntimeBinding } from "../../server/runtime/commerce/orderReviewBinding.js";
import { prepareM14ApplicationCohort, type M14ActorBackend } from "./m14ApplicationCohort.js";
import { executor, fixture, openCase, schedule } from "../helpers/fulfillmentNative.js";
import { request } from "../helpers/fulfillmentComposition.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

import { assertCatchupActivation, assertFinalCatchup, catchupCounts, catchupDrain, catchupServing, interruptPool, mediaReferences, preliminaryCatchup, seedCatchup } from "./m14ConnectedCatchup.js";
import { assertManagedArchiveAbsent, managedFirstLeg, type ManagedObligations } from "./m14ManagedCatchup.js";
import { applyRecoveryPrivacy, assertRecoveryPrivacy, assertRecoveryReady, loadOlderSnapshot, persistOlderSnapshot, persistRecoveryJson, recoveryRows, seedRecoveryPrivacy, type RecoveryPrivacyObligation } from "./m14OlderSnapshotRecovery.js";

const root = process.cwd(), image = process.argv[2], recovery = process.argv[3] === "--older-snapshot",
  managedCatchup = process.argv[3] === "--managed-catch-up",
  catchup = recovery || managedCatchup || process.argv[3] === "--catch-up";
if (process.argv[3] && !catchup) throw new Error("Unknown handover mode");
if (process.argv.length > (catchup ? 4 : 3)) throw new Error("Unknown handover arguments");
const selection: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = { generation: catchup ? "qualified-admin" : "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "transfer_owner", bootstrapLogin: "postgres", runtimeLogin: "transfer_runtime", restoreLogin: "transfer_restore" };
const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync(join(root, "config/platform-migration-manifest.json"), "utf8")),
  selection.generation, catchup ? { roleMode: "installer-managed" } : { migrationIsBootstrap: false, hasRestore: true });
const expectedUnits = [selected.baseline, ...selected.forward];
const expectedTail = expectedUnits.at(-1);
assert(expectedTail, "Selected canonical manifest must contain its baseline");
if (!catchup) assert.equal(selected.objectInventorySha256, "5fc8702f85ec1ab7c7afcc248d13ea8850c4ca84db0f9591c08104128b64ad9a");
const connectedTableCount = connectedNativeStoreTables.length;
assert.equal(connectedTableCount, 82, "Keep the 8A-extended finite graph unchanged");
if (!image || !/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error("Supply one already-local immutable Node24.21.0 image ID; this witness never pulls/builds images");
if (process.version !== "v24.21.0") throw new Error("M14 witness requires Node24.21.0");
const modules = join(root, "node_modules");
if (!existsSync(modules) || realpathSync(modules) !== modules) throw new Error("Own worktree node_modules required");
for (const name of ["core", "outbox", "platform"]) {
  if (realpathSync(join(modules, "@openlup", name)) !== join(root, "packages", name)) throw new Error("Workspace package resolution must stay in this worktree");
}
const owner = randomUUID(), label = "openlup.m14-effect-owner", roleLabel = "openlup.m14-effect-role";
const fixtureUid = process.getuid?.(), fixtureGid = process.getgid?.();
assert(fixtureUid !== undefined && fixtureGid !== undefined, "explicit POSIX owner profile required");
const fixtureUser = `${fixtureUid}:${fixtureGid}`;
const evidenceParent = join(root, ".context", "scratch", recovery ? "oss-m14-older-snapshot-recovery" : "oss-m14-connected-catchup");
mkdirSync(evidenceParent, { recursive: true, mode: 0o700 });
const scratch = realpathSync(mkdtempSync(join(evidenceParent, "journey-")));
// macOS inherits the parent directory group. Establish this owned fixture
// profile before creating any private descendants or mounting them in OCI.
chownSync(scratch, fixtureUid, fixtureGid);
console.log(JSON.stringify({ evidenceDirectory: scratch, stage: "owned-fixture-preflight" }));
const objects = join(scratch, "source-objects"), ledger = join(scratch, "provider-ledger");
mkdirSync(objects, { mode: 0o700 }); mkdirSync(ledger, { mode: 0o700 });
const containers: { name: string; id?: string; role: "executor" | "provider" }[] = [];
const databases: PostgresContainer[] = [], pools: Pool[] = [];
const times: Record<string, number> = {}, started = performance.now();
const mark = (name: string) => { times[name] = Math.round(performance.now() - started); };
const docker = (args: string[], input?: string) => execFileSync("docker", args, {
  encoding: "utf8", input, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
}).trim();
const inspect = (id: string) => JSON.parse(docker(["inspect", id]))[0];
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const control = randomUUID(); // Fixture-only authentication, never copied account credentials.
let network: string | undefined, providerUrl = "", report: Record<string, unknown> = {}, failure: unknown;
let targetWritesActivated = false;
let targetRecoveryWritesStarted = false, graphPublished = false, filesystemPublished = false, sourceWritesFrozen = false;
let nativeActivationRefusals = 0;
let application: Awaited<ReturnType<typeof prepareM14ApplicationCohort>> | undefined;
let targetApplication: OrderReviewRuntimeBinding | undefined;
let olderSnapshot: Awaited<ReturnType<typeof persistOlderSnapshot>> | undefined;
let privacySeed: Awaited<ReturnType<typeof seedRecoveryPrivacy>> | undefined;
let failureBoundary: { wall: string; monotonicMs: number } | undefined;
let unavailabilityBoundary: { wall: string; monotonicMs: number } | undefined;
const recoveryFacts = { publications: false, privacy: false, reconciled: false, authorized: false, transferred: false };
async function runTargetEffects<T>(work: () => Promise<T>): Promise<T> {
  if (recovery) assertRecoveryReady(recoveryFacts);
  return work();
}
const mediaLimits = { maximumFiles: 20, maximumObjectBytes: 1024, maximumTotalBytes: 4096 };
function pool(connectionString: string) {
  const value = new Pool({ connectionString, types: createPostgresGatewayTypeOverrides(TypeOverrides) }); pools.push(value); return value;
}
async function capture(db: Pool, sourceId: string, restricted = catchup) {
  // Existing trusted-M capture window from the restricted restore witness.
  const lease = await db.connect();
  try {
    if (restricted) await lease.query("GRANT platform_acquisition_owner TO transfer_owner WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY transfer_owner");
    return await captureConnectedNativeStore({ sourceId, catalogueId: selected.objectInventorySha256, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { async withSnapshot(work) {
      const client = lease;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const value = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT"); return value;
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { /* The held capture lease also seals the owner window below. */ }
    } } });
  } finally {
    if (restricted) await lease.query("REVOKE platform_acquisition_owner FROM transfer_owner GRANTED BY transfer_owner");
    lease.release();
  }
}
async function keyIdentity(db: Pool) {
  const client = await db.connect();
  try {
    if (catchup) await client.query("GRANT platform_acquisition_owner TO transfer_owner WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY transfer_owner");
    return (await client.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
  } finally {
    if (catchup) await client.query("REVOKE platform_acquisition_owner FROM transfer_owner GRANTED BY transfer_owner");
    client.release();
  }
}
async function census(db: Pool) {
  const rows: Record<string, string[]> = {};
  for (const table of connectedNativeStoreTables) rows[table] = (await db.query<{ value: string }>(
    `SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value FROM public."${table}" t ORDER BY pg_catalog.to_jsonb(t)::pg_catalog.text`)).rows.map(row => row.value).sort();
  return rows;
}
async function assertManagedTypedTarget(db: Pool, obligations: ManagedObligations) {
  await assertManagedArchiveAbsent(db);
  assert.deepEqual((await db.query("SELECT name FROM public.catalog_products WHERE id=$1", [obligations.productId])).rows,
    [{ name: "Retained product updated" }]);
  assert.deepEqual((await db.query("SELECT name FROM public.catalog_products WHERE id=$1", [obligations.addedProduct])).rows,
    [{ name: "New retained product" }]);
  assert.deepEqual((await db.query("SELECT id FROM public.catalog_products WHERE id=$1", [obligations.deletedProductId])).rows, []);
  assert.deepEqual((await db.query(`SELECT state FROM public.communication_recipient_consents
    WHERE recipient_fingerprint=$1 AND purpose='marketing_newsletter'`, [obligations.consentFingerprint])).rows,
    [{ state: "denied" }]);
  assert.deepEqual((await db.query("SELECT status,external_ref FROM public.commerce_settlement_intents WHERE id=$1",
    [obligations.paidIntentId])).rows, [{ status: "settled", external_ref: "provider-paid:1" }]);
  assert.deepEqual((await db.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1",
    [obligations.failedIntentId])).rows, [{ status: "failed" }]);
  assert.deepEqual((await db.query("SELECT status FROM public.subscriptions WHERE id=$1", [obligations.subscriptionId])).rows,
    [{ status: "active" }]);
  assert.deepEqual((await db.query("SELECT delivery_admission FROM public.subscription_renewal_terms WHERE subscription_id=$1",
    [obligations.subscriptionId])).rows, [{ delivery_admission: "blocked" }]);
  assert.deepEqual((await db.query("SELECT status FROM public.invoicing_duties WHERE order_id=$1",
    [obligations.paidOrderId])).rows, []);
  assert(Number((await db.query("SELECT count(*) FROM public.outbox_events WHERE aggregate_id=$1 AND status='pending'",
    [obligations.subscriptionId])).rows[0]?.count) > 0);
}
async function installation(side: string) {
  const name = `m14-effects-${side}-${owner}`, resource = await runPostgresContainer({ name, password: "synthetic-only" });
  databases.push(resource); assert(await waitForPostgresTcpReady(resource.connectionString));
  const bootstrap = pool(resource.connectionString);
  // Exact existing connected-transfer qualified fixture principals/flags. This
  // is owned disposable setup, not a new production role/grant/profile model.
  await bootstrap.query(`CREATE ROLE transfer_owner LOGIN ${catchup ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} NOCREATEDB ${catchup ? "CREATEROLE" : "NOCREATEROLE"} NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-only';
    ALTER DATABASE postgres OWNER TO transfer_owner;
    CREATE ROLE transfer_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-only';
    CREATE ROLE transfer_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-only'`);
  const url = (login: string, migration = false) => {
    const value = new URL(resource.connectionString); value.username = login;
    if (migration) value.searchParams.set("options", (selection.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(selection) : qualifiedPostgresStartupOptions(selection)));
    return value.toString();
  };
  const migrationUrl = url(selection.migrationLogin, true), ownerPool = pool(migrationUrl);
  const runner = createPostgresMigrationRunner({ connectionString: migrationUrl }, { installation: selection, poolFactory: () => ownerPool });
  assert.deepEqual(await runner.apply(), { applied: expectedUnits.map(unit => unit.file) });
  assert.deepEqual((await runner.status()).pending, []);
  if (!catchup) await bootstrap.end();
  const runtime = pool(url(selection.runtimeLogin)), restore = pool(url(selection.restoreLogin!));
  for (const [actor, login] of [[runtime, selection.runtimeLogin], [restore, selection.restoreLogin!]] as const) {
    assert.deepEqual((await actor.query("SELECT current_user,session_user")).rows, [{ current_user: login, session_user: login }]);
  }
  return { name, resource, owner: ownerPool, bootstrap, runner, runtime, restore, migrationUrl, runtimeUrl: url(selection.runtimeLogin) };
}

function owned(id: string, role: string) {
  const info = inspect(id);
  assert.equal(info.Id, id); assert.equal(info.Config.Labels[label], owner);
  assert.equal(info.Config.Labels[roleLabel], role);
  return info;
}
function isolated(id: string, role: string) {
  const info = owned(id, role);
  assert.equal(info.HostConfig.Privileged, false);
  assert.deepEqual(info.HostConfig.CapAdd ?? [], []);
  assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);
  assert.equal(info.HostConfig.RestartPolicy.Name, "no");
  assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.equal(info.Config.User, fixtureUser);
  assert(!["host", "container"].some(value => info.HostConfig.NetworkMode.startsWith(value)));
  assert(info.Mounts.every((mount: { Destination: string }) => !mount.Destination.includes("docker.sock")));
  return info;
}
async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (true) {
    const value = await read(); if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error("M14 fixture observation deadline");
    await delay(25);
  }
}
async function provider(path: string, body?: unknown) {
  const response = await fetch(`${providerUrl}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { "x-m14-control": control, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200, `synthetic provider ${path}`); return response;
}
type State = { node: string; oauthCalls: number; requests: { key: string; state: string; externalRef: string | null }[] };
const state = async (): Promise<State> => (await provider("/state")).json() as Promise<State>;
function status(directory: string): { boot: string; uid: number; gid: number; phase: string; runtimeIdentity?: unknown; credentialCached?: boolean; result?: { providerCalls: number } } | null {
  const file = join(directory, "status.json"); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
function launch(role: "provider" | "executor", args: string[]) {
  if (role === "executor") assert(!sourceWritesFrozen, "Source recreation is closed after retirement");
  // Reserve the exact identity before Docker can create a container but fail
  // OCI startup without returning its ID. Cleanup still requires both labels.
  const item: (typeof containers)[number] = { name: `m14-${role}-${owner}-${randomUUID()}`, role };
  containers.push(item);
  writeFileSync(join(scratch, "owned-containers.json"), JSON.stringify({ owner, label, roleLabel, network, containers }, null, 2));
  const id = docker(["run", "--detach", "--name", item.name, "--pull=never", "--restart=no", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--user", fixtureUser, "--cpus=1", "--memory=256m", "--pids-limit=64",
    "--label", `${label}=${owner}`, "--label", `${roleLabel}=${role}`, "--network", network!, "--env", "NODE_PG_FORCE_NATIVE=", ...args]);
  assert.match(id, /^[0-9a-f]{64}$/); item.id = id;
  writeFileSync(join(scratch, "owned-containers.json"), JSON.stringify({ owner, label, roleLabel, network, containers }, null, 2));
  const info = isolated(id, role); assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [network!]); return id;
}
function retire(id: string) {
  owned(id, "executor"); docker(["rm", "--force", "--volumes", id]);
  assert.equal(docker(["ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]), "");
  containers.splice(containers.findIndex(item => item.id === id), 1);
}

try {
  const dockerHost = readProcessEnvironment().DOCKER_HOST;
  if (dockerHost) assert.match(dockerHost, /^(unix:\/\/|npipe:\/\/)/, "remote Docker endpoint excluded");
  const context = JSON.parse(docker(["context", "inspect"]))[0];
  assert.match(context.Endpoints.docker.Host, /^(unix:\/\/|npipe:\/\/)/, "local Docker authority required");
  docker(["image", "inspect", image]); // Missing local image refuses; no pull fallback.
  network = docker(["network", "create", "--label", `${label}=${owner}`, `m14-effects-${owner}`]);
  // Docker accepts either network name or ID; inspect uses its actual name.
  network = JSON.parse(docker(["network", "inspect", network]))[0].Name;
  const providerId = launch("provider", ["--network-alias", "provider", "--publish", "127.0.0.1::8080",
    "--mount", `type=bind,src=${ledger},dst=/ledger`,
    "--mount", `type=bind,src=${join(root, "tests/postgres/fixtures/m14EffectProvider.mjs")},dst=/fixture.mjs,readonly`,
    image, "node", "/fixture.mjs", control]);
  const binding = inspect(providerId).NetworkSettings.Ports["8080/tcp"][0];
  assert.equal(binding.HostIp, "127.0.0.1"); providerUrl = `http://127.0.0.1:${binding.HostPort}`;
  await until(async () => { try { return await state(); } catch { return null; } }, value => value !== null);
  assert.equal((await state()).node, "v24.21.0", "actual OCI Node version must match the selected tool pin");

  const source = await installation("source"), target = await installation("target");
  const sourceId = inspect(source.name).Id, targetId = inspect(target.name).Id;
  writeFileSync(join(scratch, "owned-postgres.json"), JSON.stringify({ sourceId, targetId,
    sourceName: `m14-effects-source-${owner}`, targetName: `m14-effects-target-${owner}` }, null, 2));
  docker(["network", "connect", "--alias", "source-db", network!, sourceId]);
  const pristineTarget = await capture(target.owner, "owned-pristine-target");
  const targetKeyBefore = await keyIdentity(target.owner);
  const targetLedger = (await target.owner.query("SELECT catalog_path,sha256,position,executed_at::text FROM public.platform_schema_migrations ORDER BY position")).rows;
  const managedFirst = managedCatchup ? await managedFirstLeg({ final: source,
    installation: selection as QualifiedAdminPostgresInstallation,
    createPreliminary: () => installation("managed-preliminary"),
    captureNative: (db, id) => capture(db, id, true) }) : undefined;
  if (managedFirst) mark("managedFirstLegReady");
  const sourceActorUrl = new URL(source.runtimeUrl); sourceActorUrl.hostname = "source-db"; sourceActorUrl.port = "5432";
  const fixtures = await Promise.all([fixture(source.owner), fixture(source.owner), fixture(source.owner), fixture(source.owner)]);
  const duties = fixtures.map((f, index) => {
    const name = ["lost-ack", "in-flight", "paused-old", "new-target-duty"][index];
    const candidate = { ...request(), requestKey: `handover:${f.shipment}`, fulfillmentRef: f.shipment, orderRef: f.order };
    const command = JSON.stringify({ key: name, shipmentRef: f.shipment, orderRef: f.order,
      hold: name === "in-flight", acknowledge: name === "new-target-duty" });
    return { name, candidate, command, evidence: { commandFingerprint: sha(command), contactRevision: candidate.contactRevision,
      providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a" } };
  });
  for (const duty of duties) {
    await source.runtime.query("INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref) VALUES($1,$2,'warehouse-a')",
      [duty.candidate.fulfillmentRef, duty.candidate.contactRevision]);
  }
  const pending = duties[3];
  const sourceStore = createPostgresFulfillmentDispatchStore(executor(source.runtime), {
    prepare: async () => ({ disposition: "ready", contactRevision: pending.candidate.contactRevision.revision }),
    readCandidate: async () => pending.candidate,
  });
  assert.equal((await sourceStore.claim({ requestKey: pending.candidate.requestKey, fulfillmentRef: pending.candidate.fulfillmentRef,
    orderRef: pending.candidate.orderRef, parcelRef: pending.candidate.parcelRef, mode: "live", evidence: pending.evidence })).kind, "claimed");
  // Actual startup/natural interval finish before the dispatch actors' fixed
  // 30s admission holds start. Same canonical R, never a migration/owner URL.
  application = await prepareM14ApplicationCohort({ worktree: root, scratch, owner, network: network!, image,
    sourceContainerId: sourceId, sourceContainerName: source.name, sourceOwner: source.owner,
    runtime: { hostConnectionString: source.runtimeUrl, actorConnectionString: sourceActorUrl.toString(),
      login: selection.runtimeLogin, database: "postgres" } });
  mark("applicationStartupAndNaturalIntervalObserved");
  let preliminary: Awaited<ReturnType<typeof preliminaryCatchup>> | undefined;
  if (catchup) {
    const seed = await seedCatchup({ owner: source.owner, runtime: source.runtime, mediaRoot: application.mediaRoot,
      grant: application.retained.grant, subscription: fixtures[3].subscription, client: fixtures[3].client, order: fixtures[3].order });
    const provisional = await installation("preliminary");
    preliminary = await preliminaryCatchup({ owner: source.owner, runtime: source.runtime, mediaRoot: application.mediaRoot,
      grant: application.retained.grant, scratch, preliminary: { owner: provisional.owner, installation: selection }, capture, seed });
    await closePostgres(provisional.resource, [provisional.owner, provisional.bootstrap, provisional.runtime, provisional.restore]);
    mark("preliminaryRefusedAndRolledBackToSource");
  }
  // Retire/drain the real application before the backup boundary. Dispatches
  // will pause after admission; only this coordinator may change source state.
  if (recovery) {
    // Conservatively include planned application quiescence in measured RTO;
    // the separately timestamped induced failure follows provider acceptance.
    unavailabilityBoundary = { wall: new Date().toISOString(), monotonicMs: performance.now() };
    mark("inducedUnavailability");
  }
  const earlyApplicationRetirement = recovery ? await application.fenceAndRetire({ settleMediaBeforeFence: true }) : undefined;
  if (recovery) privacySeed = await seedRecoveryPrivacy(source.owner, source.runtimeUrl);
  const actors: { id: string; directory: string; name: string; boot: string; candidate: FulfillmentDispatchRequest }[] = [];
  for (const duty of duties.slice(0, 3)) {
    const { name, candidate, command, evidence } = duty, directory = join(scratch, name);
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, "input.json"), JSON.stringify({ name, candidate, command, evidence,
      connectionString: sourceActorUrl.toString(), runtimeLogin: selection.runtimeLogin,
      olderSnapshot: recovery }), { mode: 0o600 });
    const mounts = ["core", "outbox", "platform"].flatMap(pkg => ["--mount", `type=bind,src=${join(root, "packages", pkg)},dst=/workspace/packages/${pkg},readonly`]);
    if (actors.length === 0) mark("interruptionStart");
    const id = launch("executor", ["--workdir", "/workspace", ...mounts,
      "--mount", `type=bind,src=${modules},dst=/workspace/node_modules,readonly`,
      "--mount", `type=bind,src=${join(root, "tests/postgres/fixtures/m14EffectActor.mjs")},dst=/workspace/actor.mjs,readonly`,
      "--mount", `type=bind,src=${directory},dst=/control`, "--mount", `type=bind,src=${objects},dst=/source-objects`,
      image, "node", "/workspace/actor.mjs"]);
    const admitted = await until(() => status(directory), value => value?.phase === "admitted");
    assert(admitted); assert.equal(admitted.uid, fixtureUid); assert.equal(admitted.gid, fixtureGid);
    assert.equal(admitted?.credentialCached, true);
    actors.push({ id, directory, name, candidate, boot: admitted.boot });
  }
  assert.equal((await state()).oauthCalls, 3);
  // Keep the original fixture order: begin refuses an active order hold. Seed
  // the delivery-alignment case only after each old dispatch is submitting;
  // the named coordinator remains a writer until the later freeze barrier.
  for (const f of fixtures.slice(0, 3)) await openCase(source.owner, f, "auto_align");
  // Retain the actual pre-effect DB census as a diagnostic only. It is never
  // activated at target or substituted for the final sealed graph+FS capture.
  const admittedBeforeEffects = (await source.runtime.query("SELECT shipment_id,status,external_ref FROM public.fulfillment_dispatch_refs ORDER BY shipment_id")).rows;
  assert.equal(admittedBeforeEffects.filter(row => row.status === "submitting" && row.external_ref === null).length, 3);
  assert.deepEqual((await source.runtime.query("SELECT shipment_id,status,external_ref FROM public.fulfillment_dispatch_refs WHERE shipment_id=$1",
    [pending.candidate.fulfillmentRef])).rows, [{ shipment_id: pending.candidate.fulfillmentRef, status: "draft", external_ref: null }]);
  writeFileSync(join(scratch, "source-writer-inventory.json"), JSON.stringify({ dispatch: actors.map(actor => ({ id: actor.id, boot: actor.boot,
    runtimeIdentity: status(actor.directory)?.runtimeIdentity })), application: application.writer,
    coordinator: { pid: process.pid, writesUntilFreeze: ["seed/provenance and preliminary updates/deletions/new rows and objects", "source R setup and fixture HTTP", "gate releases", "installation/DDL through owned setup pools"],
      remainingAfterFreeze: "read-only canonical capture/census and serving authorization probes only" }, admittedBeforeEffects }, null, 2), { mode: 0o600 });
  if (recovery) {
    assert(earlyApplicationRetirement && privacySeed);
    assert.equal((await state()).requests.length, 0, "snapshot must precede all provider acceptance");
    olderSnapshot = await persistOlderSnapshot({ scratch, db: source.owner, mediaRoot: application.mediaRoot, capture });
    mark("olderSnapshotPersisted");
    // Persist the later erasure obligation independently of the older backup.
    // In this finite fixture it is the complete external privacy journal.
    const obligation: RecoveryPrivacyObligation = { admin: privacySeed.admin, subject: privacySeed.later, completedAt: new Date().toISOString() };
    persistRecoveryJson(join(scratch, "later-privacy-obligation.json"), obligation);
    await applyRecoveryPrivacy(source.runtimeUrl, obligation);
    await assertRecoveryPrivacy(source.owner, source.runtimeUrl, privacySeed);
    // Real elapsed time, never an altered clock or fabricated snapshot age.
    await delay(Math.max(0, 60_000 - (performance.now() - olderSnapshot.manifest.boundary.monotonicMs)));
  }
  writeFileSync(join(actors[0].directory, "release"), "release");
  await until(state, value => value.requests.some(row => row.key === "lost-ack" && row.state === "accepted"));
  writeFileSync(join(actors[1].directory, "release"), "release");
  await until(state, value => value.requests.some(row => row.key === "in-flight" && row.state === "pending"));

  if (recovery) {
    assert.equal(Number((await source.runtime.query("SELECT count(*) FROM public.fulfillment_dispatch_refs WHERE external_ref IS NOT NULL")).rows[0].count), 0,
      "provider acceptance has no local acknowledgment before induced failure");
    failureBoundary = { wall: new Date().toISOString(), monotonicMs: performance.now() };
    mark("inducedFailureAfterAcceptance");
    persistRecoveryJson(join(scratch, "induced-failure.json"), failureBoundary);
  }
  for (const actor of actors) {
    isolated(actor.id, "executor"); docker(["network", "disconnect", "--force", network!, actor.id]);
    assert.deepEqual(Object.keys(isolated(actor.id, "executor").NetworkSettings.Networks), []);
  }
  mark("oldEgressExcluded");
  // Resume the cached-bearer request after actual host enforcement, not after a
  // callback that the application itself could cache or race.
  writeFileSync(join(actors[2].directory, "release"), "release");
  const denied = await until(() => status(actors[2].directory), value => value?.phase === "completed");
  assert.equal(denied?.result?.providerCalls, 1, "old actor must actually attempt the production dispatch boundary");
  assert.equal((await state()).requests.length, 2);
  assert(existsSync(join(objects, "paused-old.txt")), "network fence must not be mistaken for an object-writer seal");
  // Provider processing can outlive the severed client socket.
  await provider("/release", { key: "in-flight" });
  assert.equal((await state()).requests.filter(row => row.state === "accepted").length, 2);
  mark("acceptedInFlightReconciliable");
  const previousBoot = status(actors[2].directory)!.boot;
  docker(["restart", actors[2].id]);
  await until(() => status(actors[2].directory), value => value?.boot !== previousBoot && value?.phase === "failed");
  assert.deepEqual(Object.keys(isolated(actors[2].id, "executor").NetworkSettings.Networks), []);
  assert.equal((await state()).requests.length, 2);
  assert.equal((await state()).oauthCalls, 3, "restart must not reacquire provider credentials through an escaped network");
  const observedDispatchBackends: M14ActorBackend[] = [];
  for (const actor of actors) {
    const applicationName = `m14-dispatch:${actor.boot}`;
    observedDispatchBackends.push(...(await (catchup ? source.bootstrap : source.owner).query<Omit<M14ActorBackend, "boot">>(`SELECT pid,
      backend_start::text AS "backendStart",datname AS database,usename AS principal,application_name AS "applicationName"
      FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND application_name=$1`, [applicationName])).rows.map(row => {
      assert.equal(row.database, "postgres"); assert.equal(row.principal, selection.runtimeLogin);
      assert.equal(row.applicationName, applicationName); assert(Number.isInteger(row.pid) && row.pid > 0);
      assert.equal(typeof row.backendStart, "string"); return { ...row, boot: actor.boot };
    }));
  }
  const retired = [...actors.map(actor => actor.id), application.id];
  for (const actor of actors) retire(actor.id);
  const applicationRetirement = earlyApplicationRetirement ?? await application.fenceAndRetire({ settleMediaBeforeFence: catchup });
  assert.equal(applicationRetirement.id, application.id);
  for (const role of ["executor", "application"]) assert.equal(docker(["ps", "--all", "--no-trunc",
    "--filter", `label=${label}=${owner}`, "--filter", `label=${roleLabel}=${role}`, "--format", "{{.ID}}"]), "");
  // M owns only this disposable DB. The process-to-session binding is actual
  // per-boot application_name plus the observed PID/start/database/principal.
  // Match again in the terminating statement; never terminate by user/prefix.
  const actorBackends = [...observedDispatchBackends, ...applicationRetirement.observedBackends];
  const bootBindings = new Map<string, string>([...actors.map(actor => [`m14-dispatch:${actor.boot}`, actor.boot] as const),
    [`m14-app:${applicationRetirement.postFence.boot}`, applicationRetirement.postFence.boot] as const]);
  const backendRetirement: { backend: M14ActorBackend; disposition: string }[] = [];
  for (const backend of actorBackends) {
    assert.equal(bootBindings.get(backend.applicationName), backend.boot);
    assert.equal(backend.database, "postgres"); assert.equal(backend.principal, selection.runtimeLogin);
    const result = await (catchup ? source.bootstrap : source.owner).query<{ terminated: boolean }>(`SELECT pg_catalog.pg_terminate_backend(pid) AS terminated
      FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz
      AND datname=$3 AND usename=$4 AND application_name=$5`,
    [backend.pid, backend.backendStart, backend.database, backend.principal, backend.applicationName]);
    assert(result.rows.length <= 1);
    if (result.rows.length) {
      assert.equal(result.rows[0].terminated, true); backendRetirement.push({ backend, disposition: "matching-owned-backend-terminated" });
    } else {
      assert.equal((await source.owner.query("SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid=$1", [backend.pid])).rows.length,
        0, "Unknown/reused backend identity refuses retirement and capture");
      backendRetirement.push({ backend, disposition: "observed-backend-already-absent" });
    }
  }
  // No source mutation handle/release/recreation is used below this point.
  // Existing privileged setup sessions and R/RR coordinator clients are closed;
  // the sole temporary source connection below has a read-only default and
  // uses only read-only snapshots/census. Other host operators are excluded.
  await Promise.all([source.runtime.end(), source.restore.end(), source.owner.end(), ...(catchup ? [source.bootstrap.end()] : [])]);
  assert(source.runtime.ended && source.restore.ended && source.owner.ended);
  sourceWritesFrozen = true;
  mark("sourceCohortRetired");
  const captureUrl = new URL(catchup ? source.resource.connectionString : source.migrationUrl);
  captureUrl.searchParams.set("options", catchup ? "-c default_transaction_read_only=on" : `${qualifiedPostgresStartupOptions(selection as QualifiedPostgresInstallation)} -c default_transaction_read_only=on`);
  const sourceReader = pool(captureUrl.toString());
  await until(async () => Number((await sourceReader.query(`SELECT count(*)::integer AS count FROM pg_catalog.pg_stat_activity
    WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()`)).rows[0].count), count => count === 0);
  const retiredGraph = await capture(sourceReader, "owned-retired-source", false);
  if (preliminary) assertFinalCatchup(preliminary, retiredGraph);
  const restoredSnapshot = olderSnapshot ? loadOlderSnapshot(olderSnapshot) : undefined;
  const finalGraph = restoredSnapshot?.graph ?? retiredGraph;
  const finalReferences = restoredSnapshot?.references ?? (catchup ? await mediaReferences(sourceReader) : []);
  const sourceRows = restoredSnapshot ? recoveryRows(finalGraph) : await census(sourceReader);
  const finalMediaStates = (await sourceReader.query("SELECT media_reference,state FROM public.commerce_order_review_media WHERE media_reference=ANY($1::text[]) ORDER BY media_reference",
    [[application.retained.pendingRef, application.retained.incompleteRef, application.retained.cleanupRef]])).rows;
  assert.equal(finalMediaStates.length, 3);
  await sourceReader.end();
  const mediaCensus = restoredSnapshot?.media ?? await captureOrderReviewMediaFilesystem({ root: application.mediaRoot, ...mediaLimits });
  const restoreMediaSource = restoredSnapshot?.mediaRoot ?? application.mediaRoot;
  if (recovery) {
    assert.notEqual(finalGraph.sha256, retiredGraph.sha256, "later erasure makes the post-failure census different from the restored older backup");
    // Retain diagnostics, not another recoverable post-failure backup packet.
    persistRecoveryJson(join(scratch, "diagnostic-retired-counts.json"), { sha256: retiredGraph.sha256, counts: catchupCounts(retiredGraph) });
  }
  writeFileSync(join(scratch, "final-source-graph.json"), JSON.stringify(finalGraph), { mode: 0o600 });
  writeFileSync(join(scratch, "final-source-media.json"), JSON.stringify(mediaCensus), { mode: 0o600 });
  const rootStat = lstatSync(objects);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  assert.equal(rootStat.mode & 0o777, 0o700); assert.equal(rootStat.uid, fixtureUid); assert.equal(rootStat.gid, fixtureGid);
  const objectInventory = readdirSync(objects, { withFileTypes: true }).map(entry => {
    const path = join(objects, entry.name), stat = lstatSync(path);
    assert(entry.isFile() && stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, fixtureUid); assert.equal(stat.gid, fixtureGid);
    const bytes = readFileSync(path);
    return { key: entry.name, bytes: bytes.length, sha256: sha(bytes), uid: stat.uid, gid: stat.gid, mode: "0600" };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const capturePoint = { retired, sourceDatabaseSha256: finalGraph.sha256, mediaCensus, markerInventory: objectInventory,
    applicationRetirement, backendRetirement, finalMediaStates, coordinator: { pid: process.pid, sourceWritesFrozen, sourceMutationPoolsClosed: true,
      sourceCapturePoolClosed: sourceReader.ended, sourceAdministrationClosed: source.bootstrap.ended, finalCapture: "canonical read-only graph plus complete objects/tmp census" },
    ownerProfile: { targetProcessUid: process.getuid!(), targetProcessGid: process.getgid!(),
      sourceActors: actors.map(actor => ({ id: actor.id, uid: status(actor.directory)?.uid, gid: status(actor.directory)?.gid })),
      objectRoot: { uid: rootStat.uid, gid: rootStat.gid, mode: "0700" },
      additionalAclAssurance: "POSIX mode/UID witness only; actual adopter ACL and host-owner qualification remain separate" },
    writerInventory: [...actors.map(actor => ({ id: actor.id, boot: actor.boot, runtimeLogin: selection.runtimeLogin,
      writes: ["native fulfillment dispatch", `source-objects/${actor.name}.txt`],
      ingress: "none", scheduling: "one-shot fixture only", recreation: "exclusive local Docker host" })), application.writer],
    boundary: "Exactly three dispatch processes, one actual application process and this frozen coordinator; excludes unregistered modules/jobs/webhooks and other host operators" };
  writeFileSync(join(scratch, "final-capture-point.json"), JSON.stringify(capturePoint, null, 2)); mark("finalCapturePoint");

  // Target remains inactive until BOTH existing canonical publications complete.
  // These imports preserve all 73 tables/raw JSON rows and the whole private
  // objects/tmp root; no pg_dump/psql clone, schema/grant copy or lease editing.
  const targetMediaRoot = join(scratch, "target-media");
  const mediaInput = { census: mediaCensus, ...mediaLimits,
    objects: createOrderReviewMediaTransferReader({ root: restoreMediaSource, maximumObjectBytes: mediaLimits.maximumObjectBytes }),
    temporary: createOrderReviewMediaTransferReader({ root: restoreMediaSource, maximumObjectBytes: mediaLimits.maximumObjectBytes, area: "tmp" }) };
  let objectInterruption = false;
  if (catchup) {
    let completedReads = 0;
    const brokenReader = { async read(key: string, version?: string) {
      const read = await mediaInput.objects.read(key, version);
      if (++completedReads === 2) { objectInterruption = true; throw new Error("synthetic object import interruption"); }
      return read;
    } };
    await assert.rejects(stageOrderReviewMediaFilesystem({ ...mediaInput, objects: brokenReader,
      servingRoot: targetMediaRoot, generationId: "final" }), { code: "unavailable" });
    assert(objectInterruption);
    assert(!existsSync(join(scratch, ".openlup-inactive-media-final")));
  }
  const filesystemRestore = catchup ? await stageOrderReviewMediaFilesystem({ ...mediaInput,
    servingRoot: targetMediaRoot, generationId: "final" }) : await restoreOrderReviewMediaFilesystem({ root: targetMediaRoot, census: mediaCensus, ...mediaLimits,
    objects: createOrderReviewMediaTransferReader({ root: application.mediaRoot, maximumObjectBytes: mediaLimits.maximumObjectBytes }),
    temporary: createOrderReviewMediaTransferReader({ root: application.mediaRoot, maximumObjectBytes: mediaLimits.maximumObjectBytes, area: "tmp" }) });
  const finalMediaRoot = "generationRoot" in filesystemRestore && typeof filesystemRestore.generationRoot === "string" ? filesystemRestore.generationRoot : targetMediaRoot;
  filesystemPublished = true;
  const graphRestore = await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: finalGraph, freshTarget: pristineTarget });
  assert.deepEqual(await keyIdentity(target.owner), targetKeyBefore);
  graphPublished = true;
  assert.deepEqual(await census(target.owner), sourceRows);
  const restoredMediaCensus = await captureOrderReviewMediaFilesystem({ root: finalMediaRoot, ...mediaLimits });
  assert.deepEqual(restoredMediaCensus, mediaCensus);
  assert.deepEqual((await target.owner.query("SELECT catalog_path,sha256,position,executed_at::text FROM public.platform_schema_migrations ORDER BY position")).rows, targetLedger);
  mark("canonicalGraphAndFilesystemPublished");
  if (managedFirst) {
    await assertManagedTypedTarget(target.runtime, managedFirst.obligations);
    mark("managedTypedStateReadBackAtSecondTarget");
  }
  let recoveredRowsAfterPrivacy: Record<string, string[]> | undefined;
  if (recovery) {
    recoveryFacts.publications = true;
    assert.throws(() => assertRecoveryReady(recoveryFacts), /older_snapshot_recovery_fenced/);
    let workerEntered = false;
    await assert.rejects(runTargetEffects(async () => { workerEntered = true; }), /older_snapshot_recovery_fenced/);
    assert.equal(workerEntered, false, "same target effect entry refuses before any reconciliation");
    assert.equal((await state()).requests.length, 2);
    assert(privacySeed);
    const stale = (await target.owner.query("SELECT email FROM public.clients WHERE id=$1", [privacySeed.later.contact])).rows[0];
    assert.equal(stale.email, privacySeed.later.email, "prove actual older unredacted data was restored while serving remains closed");
    const journal = join(scratch, "later-privacy-obligation.json");
    const obligation: RecoveryPrivacyObligation = JSON.parse(readFileSync(journal, "utf8"));
    assert.deepEqual(obligation.subject, privacySeed.later);
    await applyRecoveryPrivacy(target.runtimeUrl, obligation);
    await assertRecoveryPrivacy(target.owner, target.runtimeUrl, privacySeed);
    recoveredRowsAfterPrivacy = await census(target.owner);
    const retiredRows = recoveryRows(retiredGraph);
    for (const table of connectedNativeStoreTables) {
      assert.equal(recoveredRowsAfterPrivacy[table].length, retiredRows[table].length, `no lost retained rows: ${table}`);
      // Source dispatch outcomes can have become uncertain after the socket
      // failure; target reconciliation below must independently resolve them.
      if (table === "fulfillment_dispatch_refs") continue;
      const normalize = (rows: string[]) => rows.map(row => {
        if (table !== "clients") return row; // Preserve lossless int8/numeric history text.
        const value = JSON.parse(row);
        // Erasure's actual transaction records its own local mutation time.
        delete value.updated_at;
        return JSON.stringify(value);
      }).sort();
      assert.deepEqual(normalize(recoveredRowsAfterPrivacy[table]), normalize(retiredRows[table]), `retained history and privacy exact: ${table}`);
    }
    recoveryFacts.privacy = true;
    mark("laterPrivacyReappliedBeforeServing");
  }
  let agreement: Awaited<ReturnType<typeof catchupServing>> | undefined;
  const drain = catchup ? catchupDrain() : undefined;
  if (catchup) {
    const sourceProbeUrl = new URL(source.runtimeUrl);
    sourceProbeUrl.searchParams.set("options", "-c default_transaction_read_only=on");
    const sourceProbe = pool(sourceProbeUrl.toString());
    try {
      agreement = await catchupServing({ source: sourceProbe, target: target.runtime, sourceRoot: application.mediaRoot,
        targetRoot: finalMediaRoot, grant: application.retained.grant, otherGrant: preliminary!.otherGrant, census: mediaCensus, references: finalReferences });
    } finally { await sourceProbe.end(); }
    if (recovery) recoveryFacts.authorized = true;
    assert(preliminary);
    assert.notEqual(preliminary.staged.generationRoot, finalMediaRoot);
    const changed = mediaCensus.objects.find(row => row.key === preliminary.changes.updated.key);
    assert.equal(changed?.sha256, preliminary.changes.updated.sha256);
    assert.equal(changed?.bytes, preliminary.changes.updated.bytes);
    assert(mediaCensus.objects.some(row => row.key === preliminary.changes.added.key));
    assert(mediaCensus.temporary.some(row => `tmp/${row.key}` === preliminary.partial.key && row.bytes > 0 && row.bytes < 100));
    assert(finalReferences.some(row => row.mediaReference === preliminary.partial.ref && row.state === "pending" && row.tempKey === preliminary.partial.key));
    const deleted = preliminary.media.objects.filter(row => !mediaCensus.objects.some(value => value.key === row.key));
    assert(deleted.length > 0, "actual in-flight source deletion is absent from final generation");
    assert.equal((await target.runner.status()).pending.length, 0);
  }
  const scheduleBefore = await Promise.all(fixtures.map(f => schedule(target.runtime, f.subscription)));
  const mediaRead = createPostgresOrderReviewMediaPort(target.runtime);
  for (const row of finalMediaStates) {
    const authorized = await mediaRead.readAuthorized(application.retained.grant, String(row.media_reference));
    assert.equal(authorized !== null, row.state === "confirmed", "Actual retained media state governs customer visibility before runtime reconciliation");
  }

  // Restart the independent provider from its own fsynced ledger. Target never
  // receives a known external ID except through these authenticated observations.
  const acceptedBeforeRestart = (await state()).requests;
  assert.equal(new Set(acceptedBeforeRestart.map(row => row.externalRef)).size, 2);
  docker(["restart", providerId]);
  // Docker may allocate a new ephemeral host port on restart. Keep the same
  // owned provider and ledger, but observe its actual loopback binding again.
  const restartedBinding = inspect(providerId).NetworkSettings.Ports["8080/tcp"][0];
  assert.equal(restartedBinding.HostIp, "127.0.0.1");
  providerUrl = `http://127.0.0.1:${restartedBinding.HostPort}`;
  writeFileSync(join(scratch, "provider-restart.json"), JSON.stringify({ before: binding, after: restartedBinding }), { mode: 0o600 });
  await until(async () => { try { return await state(); } catch { return null; } }, value => value !== null);
  assert.deepEqual((await state()).requests, acceptedBeforeRestart);
  const sql = executor(target.runtime), spine = createPostgresFulfillmentShipmentSpinePort(sql, { portKey: "fixture-port" });
  const arrival = createPostgresDeliveryAlignmentPort(sql);
  const lifecycle = createPostgresFulfillmentObservationLifecycle(sql, { providerRef: "warehouse-a",
    acceptanceKeys: ref => ({ providerAttemptKey: `accepted:${ref}`, labelKey: `receipt:${ref}` }) });
  async function reconcileSignedPage() {
    const response = await provider("/observations"), text = await response.text();
    assert(verifyHmacSignature({ rawBody: text, signatureHeader: response.headers.get("x-m14-signature") ?? undefined, secret: control }));
    const page = JSON.parse(text) as FulfillmentObservation[];
    for (const wire of page) {
      // The target host mints its own evidence pointer. Never adopt a provider
      // reference as an application raw-evidence identity; reuse the existing
      // stored pointer on replay rather than adding a second evidence registry.
      const digest = sha(JSON.stringify(wire));
      const previous = (await target.runtime.query("SELECT observation FROM public.fulfillment_observations WHERE event_key=$1", [wire.eventKey])).rows[0]?.observation as FulfillmentObservation | undefined;
      if (previous) assert.equal(previous.fact.rawEvent.digest, digest, "same provider event must retain its original wire bytes");
      const observation: FulfillmentObservation = { ...wire, fact: { ...wire.fact,
        rawEvent: previous?.fact.rawEvent ?? { reference: `evidence:${randomUUID()}`, digestAlgorithm: "sha256", digest } } };
      await spine.localPersistence.recordObservation(observation);
      const ref = await lifecycle.findDispatchRef(observation); assert(ref);
      await lifecycle.acknowledgeDispatchAcceptance(ref, observation);
      const latest = await spine.localPersistence.latestStatusOccurredAt(ref.fulfillmentRef);
      if (latest && observation.fact.occurredAt && Date.parse(latest) > Date.parse(observation.fact.occurredAt)) continue;
      await spine.localPersistence.recordStatusEvidence(ref, observation);
      if (observation.eventKind === "order.delivered") {
        assert(observation.fact.occurredAt);
        await arrival.recordArrival({ requestKey: `arrival:${observation.eventKey}`, parcelRef: ref.fulfillmentRef,
          deliveredAt: observation.fact.occurredAt, evidenceRef: observation.fact.rawEvent.reference });
      }
      await spine.localPersistence.markProcessed(observation.eventKey, { status: "processed" });
    }
  }
  if (catchup) assert(graphPublished && filesystemPublished && sourceWritesFrozen && agreement && drain,
    "catchup_recovery_requires_database_objects_acl_drain_and_retirement");
  targetRecoveryWritesStarted = true;
  // A killed old process can leave submitting after its final DB socket failed.
  // Preserve that actual source state through import, then use the existing R
  // transition to uncertain; neither accepted effects nor absence are invented.
  await target.runtime.query(`SELECT public.fulfillment_dispatch_finish(id,
    '{"kind":"unknown","effectMayHaveSucceeded":true,"refusal":{"reason":"io_failure","phase":"dispatch","retryable":false}}'::jsonb,false)
    FROM public.fulfillment_dispatch_refs WHERE status='submitting'`);
  await reconcileSignedPage();
  assert.equal(Number((await target.runtime.query("SELECT count(*) FROM public.fulfillment_dispatch_refs WHERE status='created' AND external_ref IS NOT NULL")).rows[0].count), 2);
  assert.equal(Number((await target.runtime.query("SELECT count(*) FROM public.subscription_delivery_alignment_arrivals")).rows[0].count), 0);
  await provider("/late", { key: "lost-ack" }); await reconcileSignedPage();
  const afterArrival = await schedule(target.runtime, fixtures[0].subscription);
  assert(new Date(afterArrival.next_cycle_at).getTime() > new Date(scheduleBefore[0].next_cycle_at).getTime());
  await reconcileSignedPage(); assert.deepEqual(await schedule(target.runtime, fixtures[0].subscription), afterArrival);
  assert.deepEqual(await schedule(target.runtime, fixtures[1].subscription), scheduleBefore[1]);
  assert.deepEqual(await schedule(target.runtime, fixtures[2].subscription), scheduleBefore[2]);
  assert.deepEqual(await schedule(target.runtime, fixtures[3].subscription), scheduleBefore[3]);
  assert.equal(Number((await target.runtime.query("SELECT count(*) FROM public.subscription_delivery_alignment_arrivals")).rows[0].count), 1);
  assert.equal((await state()).requests.length, 2, "target recovery must never create another external effect");
  const uncertainBefore = await sql.query("SELECT * FROM public.fulfillment_dispatch_refs WHERE shipment_id=$1", [fixtures[2].shipment]);
  assert.equal(uncertainBefore.rows[0].status, "uncertain");
  const acceptedBefore = await sql.query("SELECT * FROM public.fulfillment_dispatch_refs WHERE external_ref IS NOT NULL ORDER BY shipment_id");
  mark("acceptedEffectsRecovered");
  // The complete retained census includes the uncertain operation. Only that
  // operation remains fenced; the existing worker can continue to ordinary work.
  const dispatchCensus = () => sql.query("SELECT shipment_id,status,external_ref FROM public.fulfillment_dispatch_refs ORDER BY shipment_id");
  const beforeActivation = (await dispatchCensus()).rows;
  assert.deepEqual(beforeActivation.map(row => row.shipment_id).sort(), fixtures.map(f => f.shipment).sort());
  const authentication = await fetch(`${providerUrl}/oauth/auth`, { signal: AbortSignal.timeout(2000) });
  assert.equal(authentication.status, 200);
  const token = await authentication.json() as { access_token: string }; assert(token.access_token);
  const targetPosts: string[] = [], listed: string[][] = [];
  const targetStore = createPostgresFulfillmentDispatchStore(sql, {
    prepare: async ref => {
      const duty = duties.find(value => value.candidate.fulfillmentRef === ref); assert(duty);
      return { disposition: "ready", contactRevision: duty.candidate.contactRevision.revision };
    },
    readCandidate: async ref => duties.find(value => value.candidate.fulfillmentRef === ref)?.candidate ?? null,
  });
  const targetWorker = () => runFulfillmentDispatchWorker({ store: targetStore,
    async listCandidates(limit) {
      const rows = (await sql.query(`SELECT id,order_id FROM public.fulfillment_shipments
        WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id) LIMIT $2`,
      [duties.map(duty => duty.candidate.fulfillmentRef), limit])).rows;
      listed.push(rows.map(row => String(row.id)));
      return rows.map(row => {
        const duty = duties.find(value => value.candidate.fulfillmentRef === row.id); assert(duty);
        assert.equal(row.order_id, duty.candidate.orderRef); return duty.candidate;
      });
    },
    provider: {
      async prepare(candidate) {
        const duty = duties.find(value => value.candidate.fulfillmentRef === candidate.fulfillmentRef); assert(duty);
        return { kind: "prepared", evidence: duty.evidence };
      },
      async dispatch(candidate, evidence) {
        const duty = duties.find(value => value.candidate.fulfillmentRef === candidate.fulfillmentRef); assert(duty);
        targetPosts.push(candidate.fulfillmentRef);
        const response = await fetch(`${providerUrl}/effects`, { method: "POST",
          headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
          body: duty.command, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        const { externalRef } = await response.json() as { externalRef: string }; assert.match(externalRef, /^external-/);
        return { kind: "accepted", externalRef, evidence, providerAttemptKey: `accepted:${candidate.fulfillmentRef}`,
          labelKey: `receipt:${candidate.fulfillmentRef}` };
      },
    },
    config: { mode: "live", batchLimit: 4 },
    keys: { request: candidate => candidate.requestKey, mappedAttempt: key => `mapped:${key}`,
      acceptance: ref => ({ providerAttemptKey: `accepted:${ref}`, labelKey: `receipt:${ref}` }) },
  });
  const executeTarget = () => runTargetEffects(targetWorker);
  if (recovery) {
    // The real worker entry remains closed before ownership transfer, even
    // after its stores and provider binding are prepared.
    await assert.rejects(executeTarget(), /older_snapshot_recovery_fenced/);
    assert.deepEqual(targetPosts, []);
    recoveryFacts.reconciled = true;
  }
  const targetMediaPool = pool(target.runtimeUrl);
  assert.deepEqual((await targetMediaPool.query("SELECT current_user,session_user")).rows,
    [{ current_user: selection.runtimeLogin, session_user: selection.runtimeLogin }]);
  const targetMediaStore = await OrderReviewMediaObjectStore.create(finalMediaRoot);
  const targetEnvironment = { ...drain?.env, PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: target.runtimeUrl,
    ORDER_REVIEW_MEDIA_ROOT: finalMediaRoot };
  if (catchup) {
    const activationFacts = { sourceFrozen: sourceWritesFrozen, graphPublished, filesystemPublished,
      qualified: (await target.runner.status()).pending.length === 0,
      generation: finalMediaRoot, finalGeneration: join(scratch, ".openlup-inactive-media-final"),
      serving: agreement?.serving, drain: targetEnvironment,
      effects: { accepted: acceptedBefore.rows.length, uncertain: beforeActivation.filter(row => row.status === "uncertain").length,
        pending: beforeActivation.filter(row => row.status === "draft").length } };
    for (const delta of [{ sourceFrozen: false }, { graphPublished: false }, { filesystemPublished: false },
      { qualified: false }, { generation: preliminary!.staged.generationRoot }, { serving: undefined },
      { drain: undefined }, { effects: { accepted: 1, uncertain: 2, pending: 1 } }]) {
      assert.throws(() => assertCatchupActivation({ ...activationFacts, ...delta }), /catchup_activation_agreement_required/);
      assert.equal(targetWritesActivated, false);
      nativeActivationRefusals++;
    }
    assertCatchupActivation(activationFacts);
    assert.equal((await state()).requests.length, 2);
  }
  targetWritesActivated = true; // compose immediately schedules genuine reconciliation.
  if (recovery) {
    recoveryFacts.transferred = true;
    assertRecoveryReady(recoveryFacts);
    // Recreate neither a source process nor its DB sessions after transfer.
    // The exact old executor identity has been terminally retired by the host.
    assert.throws(() => docker(["start", actors[0].id]), (error: unknown) => error instanceof Error
      && "status" in error && error.status === 1 && "stderr" in error
      && typeof error.stderr === "string" && /No such container/.test(error.stderr));
    assert.equal(docker(["ps", "--all", "--no-trunc", "--filter", `id=${actors[0].id}`, "--format", "{{.ID}}"]), "");
    assert.equal((await state()).requests.length, 2);
    mark("oldExecutorRestartRefusedAfterTransfer");
  }
  targetApplication = await resolveOrderReviewRuntimeBinding(targetEnvironment, { store: targetMediaStore, resources: {
    executor: executor(targetMediaPool), close: () => targetMediaPool.end(), transaction: { async run(work) {
      const client = await targetMediaPool.connect();
      try { await client.query("BEGIN"); const value = await work(executor(client)); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
    } } } }) ?? undefined;
  assert(targetApplication);
  assert.equal((await targetApplication.customer.read(application.retained.grant)).ok, true);
  mark("targetApplicationRuntimeStarted");
  const targetResult = await executeTarget();
  assert.deepEqual(listed[0], duties.map(duty => duty.candidate.fulfillmentRef));
  assert.deepEqual(targetPosts, [pending.candidate.fulfillmentRef]);
  assert.equal(targetResult.ok, false, "the retained uncertain operation still reports its refusal");
  assert.equal(targetResult.reason, "dispatch_not_safe_to_submit:uncertain");
  assert.deepEqual((await sql.query("SELECT * FROM public.fulfillment_dispatch_refs WHERE shipment_id=$1", [fixtures[2].shipment])).rows, uncertainBefore.rows);
  assert.deepEqual((await sql.query("SELECT * FROM public.fulfillment_dispatch_refs WHERE shipment_id<>$1 AND external_ref IS NOT NULL ORDER BY shipment_id",
    [pending.candidate.fulfillmentRef])).rows, acceptedBefore.rows);
  const created = await targetStore.read(pending.candidate.requestKey); assert(created);
  assert.equal(created.status, "created"); assert(created.externalRef);
  const effects = (await state()).requests;
  assert.equal(effects.length, 3); assert.equal(effects.filter(row => row.key === pending.name && row.state === "accepted").length, 1);
  const repeatedTargetResult = await executeTarget();
  assert.deepEqual(targetPosts, [pending.candidate.fulfillmentRef]);
  assert.equal((await state()).requests.length, 3);
  assert.deepEqual(await targetStore.read(pending.candidate.requestKey), created);
  const afterActivation = (await dispatchCensus()).rows;
  assert.deepEqual(afterActivation.map(row => row.shipment_id).sort(), fixtures.map(f => f.shipment).sort());
  const unresolved = afterActivation.filter(row => row.external_ref === null);
  assert.deepEqual(unresolved, [{ shipment_id: fixtures[2].shipment, status: "uncertain", external_ref: null }]);
  assert.deepEqual(await schedule(target.runtime, fixtures[3].subscription), scheduleBefore[3]);
  if (catchup) {
    for (const table of ["subscription_renewal_terms", "subscription_renewal_term_lines", "commerce_settlement_intents", "invoicing_duties"]) {
      const values = (await target.runtime.query(`SELECT pg_catalog.to_jsonb(t)::text AS value FROM public."${table}" t ORDER BY pg_catalog.to_jsonb(t)::text`)).rows.map(row => row.value);
      const expected = [...finalGraph.compatible.tables, ...finalGraph.owned].find(row => row.table === table); assert(expected);
      assert.deepEqual(values.sort(), [...expected.rows].sort(),
        "ordinary takeover preserves frozen terms, unsettled money and invoice duties");
    }
  }
  if (catchup) {
    const expected = finalGraph.compatible.tables.find(table => table.table === "outbox_events")!.rows.filter(row => JSON.parse(row).idempotency_key === "catchup-effect-key");
    assert.equal(expected.length, 1);
    assert.deepEqual((await target.runtime.query("SELECT pg_catalog.to_jsonb(t)::text AS value FROM public.outbox_events t WHERE idempotency_key='catchup-effect-key'")).rows.map(row => row.value), expected);
  }
  if (managedFirst) await assertManagedTypedTarget(target.runtime, managedFirst.obligations);
  mark("selectedTargetReady");
  const declaredReadiness = { wall: new Date().toISOString(), monotonicMs: performance.now() };
  let recoveryMeasurement: Record<string, unknown> | undefined;
  if (recovery) {
    assert(restoredSnapshot && olderSnapshot && failureBoundary && unavailabilityBoundary && privacySeed && recoveredRowsAfterPrivacy);
    const recoveredRetainedRows = recoveredRowsAfterPrivacy;
    assertRecoveryReady(recoveryFacts);
    await assertRecoveryPrivacy(target.owner, target.runtimeUrl, privacySeed);
    const tableCounts = catchupCounts(finalGraph);
    const obligations = Object.fromEntries(["fulfillment_dispatch_refs", "commerce_settlement_intents", "invoicing_duties", "outbox_events"]
      .map(table => [table, tableCounts[table]]));
    const pendingMediaObligations = finalGraph.owned.find(table => table.table === "commerce_order_review_media")!.rows
      .filter(row => ["pending", "cleanup_pending"].includes(JSON.parse(row).state)).length;
    assert.equal(obligations.fulfillment_dispatch_refs, 4);
    recoveryMeasurement = { format: "openlup.local-older-snapshot-recovery.v1",
      snapshotBoundary: restoredSnapshot.boundary.wall, latestRecoverableConsistentBoundary: restoredSnapshot.boundary.wall,
      inducedUnavailability: unavailabilityBoundary.wall, inducedFailure: failureBoundary.wall, declaredReadiness: declaredReadiness.wall,
      snapshotAgeSeconds: (failureBoundary.monotonicMs - restoredSnapshot.boundary.monotonicMs) / 1000,
      effectiveRpoSeconds: (failureBoundary.monotonicMs - restoredSnapshot.boundary.monotonicMs) / 1000,
      rtoSeconds: (declaredReadiness.monotonicMs - unavailabilityBoundary.monotonicMs) / 1000,
      unavailabilityDefinition: "conservative start at planned application retirement for consistent backup; includes backup/quiescence before induced post-acceptance failure",
      readiness: { ...recoveryFacts, permitsVisibleFencedUncertainty: true,
        includes: ["restore", "object publication", "privacy replay", "effect reconciliation", "authorization", "serving", "ordinary-job readback and replay"],
        scope: "finite local native connected graph and private media; one explicit uncertain dispatch refusal permitted" },
      humanWaitSeconds: 0, accessWaitSeconds: 0,
      counts: { recoveredSnapshotRows: Object.values(tableCounts).reduce((sum, count) => sum + count, 0),
        recoveredSnapshotObjects: mediaCensus.objects.length, recoveredPartialFiles: mediaCensus.temporary.length,
        lostRows: Object.entries(recoveryRows(retiredGraph)).reduce((sum, [table, rows]) => sum + Math.max(0, rows.length - recoveredRetainedRows[table].length), 0),
        lostObjects: mediaCensus.objects.filter(object => !restoredMediaCensus.objects.some(value => value.key === object.key && value.sha256 === object.sha256)).length,
        lostPartialFiles: mediaCensus.temporary.filter(object => !restoredMediaCensus.temporary.some(value => value.key === object.key && value.sha256 === object.sha256)).length,
        lostObligations: Object.keys(obligations).reduce((sum, table) => sum + Math.max(0, tableCounts[table] - recoveredRetainedRows[table].length), 0),
        recoveredObligationCount: Object.values(obligations).reduce((sum, count) => sum + count, 0) + pendingMediaObligations,
        recoveredObligations: { ...obligations, pendingMedia: pendingMediaObligations },
        recoveredPostSnapshotErasureReceipts: 1, recoveredAcceptedEffects: 2,
        uncertainDispatchObligations: 1, ordinaryDutyAcceptedExactlyOnce: 1 },
      fixture: { tables: tableCounts, graphBytes: readFileSync(join(olderSnapshot.root, "graph.json")).length,
        objectBytes: [...mediaCensus.objects, ...mediaCensus.temporary].reduce((sum, object) => sum + object.bytes, 0),
        maximumRows: 10000, maximumGraphBytes: 64 * 1024 * 1024, mediaLimits,
        excludedDiagnosticMarkerFiles: objectInventory.length },
      privacy: { existingErasurePreserved: true, laterErasureAndRetainedTextRedactionReappliedBeforeServing: true,
        staleRestoredContactObservedOnlyBehindFence: true, erasedAuthenticationRefused: true,
        managedSourceArchive: "managed history-only rows remain with the operator source; this mode selects native data" },
      safeRefusals: [{ reason: "new executor fenced before reconciliation and ownership transfer", rtoSeconds: null },
        { reason: "exact old executor restart refused after terminal host retirement and transfer", rtoSeconds: null },
        { reason: "uncertain dispatch remains visible and cannot resubmit", rtoSeconds: null }],
      source: "persisted pre-provider-acceptance DB packet and complete private media copy, reloaded from disk",
      postFailureDiagnosticGraphUsedForRestore: false, noSloClaim: true, hostedQualification: false };
    assert(Number(recoveryMeasurement.snapshotAgeSeconds) >= 60);
    persistRecoveryJson(join(scratch, "recovery-measurement.json"), recoveryMeasurement);
  }
  report = { outcome: "LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION", node: process.version, image, owner,
    recovery: recoveryMeasurement,
    journey: catchup ? { format: "openlup.local-connected-catchup.v1",
      leg: managedCatchup ? "managed-to-portable-to-portable" : "portable-to-portable",
      sourceGeneration: managedFirst?.report.sourceGeneration ?? selection.generation, targetGeneration: selection.generation,
      managedFirstLeg: managedFirst?.report,
      preliminary: preliminary!.report, final: { captureSha256: finalGraph.sha256, counts: catchupCounts(finalGraph),
        sourceInstallation: finalGraph.observation, targetInstallation: pristineTarget.observation,
        targetInstallationKeyTuplePreserved: targetKeyBefore, sourceOutsideProfile: finalGraph.outsideProfileCensus,
        targetOutsideProfile: pristineTarget.outsideProfileCensus,
        objects: mediaCensus.objects.length, temporary: mediaCensus.temporary.length,
        objectImportInterrupted: objectInterruption, objectImportResumed: true, agreement, drain,
        settingsDiscriminator: { updatedRows: 1, deletedRows: 1, addedRows: 1 },
        objectChanges: {
          updated: mediaCensus.objects.filter(row => preliminary!.media.objects.some(value => value.key === row.key && value.sha256 !== row.sha256)).length,
          added: mediaCensus.objects.filter(row => !preliminary!.media.objects.some(value => value.key === row.key)).length,
          deleted: preliminary!.media.objects.filter(row => !mediaCensus.objects.some(value => value.key === row.key)).length },
        managedHistoryOnlyRowsAbsent: managedCatchup ? true : undefined },
      refusals: [...(managedFirst ? [managedFirst.report.preliminary.refusal,
        `${managedFirst.report.activation.refusalCases} managed first-leg agreement cases refused`] : []),
        preliminary!.report.refusal, "retained uncertain dispatch remains fenced"],
      activationRefusalCases: nativeActivationRefusals
        + (managedFirst ? managedFirst.report.activation.refusalCases + 1 : 0),
      takeover: targetWritesActivated, rollback: preliminary!.report.rollback,
      timingsMs: times, hostedQualification: false, olderSnapshotRecovery: recovery } : undefined,
    catalogue: { units: expectedUnits.length, tail: expectedTail, inventorySha256: selected.objectInventorySha256 },
    capturePoint, filesystemRestore, graphRestore, timesMs: times, recoveredAcceptedEffects: 2,
    unresolved, sourceWritesFrozen, filesystemPublished, graphPublished, targetRecoveryWritesStarted, targetWritesActivated, targetResult, repeatedTargetResult, targetPosts,
    beforeActivation, afterActivation, selectedProfileReadyRtoMs: times.selectedTargetReady - (recovery ? times.inducedUnavailability : times.interruptionStart),
    readyScope: `Owned selected canonical ${connectedTableCount}-table graph and complete private media root; four-process/coordinator retirement, two accepted effects recovered, one uncertain operation fenced and one ordinary duty dispatched/replayed through actual R`,
    wholeStoreRtoMs: null,
    acceptedRecoveryElapsedMs: times.acceptedEffectsRecovered - times.interruptionStart,
    recoveryPoint: recovery ? "Persisted pre-provider-acceptance DB/object snapshot; later privacy obligations replayed before serving and independent accepted effects reconciled. One uncertain operation remains fenced. Finite local scope, no SLO."
      : "Final source graph and objects/tmp captured after terminal retirement; two independent accepted effects reconciled, retained pending/cleanup and one uncertain dispatch obligation preserved. No zero-RPO or all-store readiness claim.",
    actualProvider: "synthetic fixture only; no external-provider or hosted guarantee" };
} catch (error) { failure = error; report = { outcome: "INCOMPLETE", timesMs: times, sourceWritesFrozen,
  filesystemPublished, graphPublished, targetRecoveryWritesStarted, targetWritesActivated,
  selectedProfileReadyRtoMs: null, wholeStoreRtoMs: null,
  recovery: recovery ? { outcome: "INCOMPLETE_OR_SAFE_REFUSAL", rtoSeconds: null, snapshotBoundary: olderSnapshot?.manifest.boundary.wall,
    inducedUnavailability: failureBoundary?.wall, facts: recoveryFacts } : undefined }; }
finally {
  const cleanup: string[] = [];
  try { await targetApplication?.close(); } catch { cleanup.push("target-application-binding"); }
  try { await application?.cleanup(); } catch { cleanup.push("source-application-cohort"); }
  for (const item of [...containers].reverse()) {
    try {
      const found = docker(["ps", "--all", "--no-trunc", "--filter", `name=^/${item.name}$`, "--format", "{{.ID}}"]);
      if (!found) { assert.equal(item.id, undefined, "Previously observed owned container unexpectedly absent"); continue; }
      assert.match(found, /^[0-9a-f]{64}$/);
      if (item.id) assert.equal(found, item.id);
      const info = owned(found, item.role); assert.equal(info.Name, `/${item.name}`);
      docker(["rm", "--force", "--volumes", found]);
    } catch { cleanup.push(`container:${item.name}`); }
  }
  try { await closePostgres(databases, pools); } catch { cleanup.push("owned-postgres"); }
  if (network) {
    try {
      const info = JSON.parse(docker(["network", "inspect", network]))[0]; assert.equal(info.Labels[label], owner);
      docker(["network", "rm", info.Id]);
    } catch { cleanup.push("owned-network"); }
  }
  report.cleanupFailures = cleanup;
  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  if (cleanup.length && !failure) failure = new Error("M14 owned fixture cleanup incomplete");
}
console.log(JSON.stringify({ evidenceDirectory: scratch, outcome: report.outcome }));
if (failure) throw failure;
