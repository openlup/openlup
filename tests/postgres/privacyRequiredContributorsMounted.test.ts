import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSchemaProbe } from "@openlup/core/readiness";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import type { PgQueryExecutor } from "@openlup/platform/data";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import * as identity from "@openlup/platform/identity";
import type { ErasureReceipt, PrivacyEraseRequest, PrivacyExport } from "@openlup/platform/identity/contracts";
import { PostgresTransferError } from "@openlup/platform/portability";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { nativePrivacyContributors } from "../../server/runtime/auth/privacyBinding.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { buildIdentityReferenceRuntime } from "../identity/acceptance.conformance.js";
import { createAccountMutationsTemplate, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
import { activation, allocate, defaultRule, utc } from "./nativeRenewalOccurrence.fixture.js";
import { applyMeasuredOccurrencePrefix, args, committedAllocation, installMeasuredAccountPrefix, occurrence,
  occurrenceCatalogue, occurrenceForwardPath, original, paidRootFixture, rootFixture, sliceOccurrencePlan, writer,
  writerPlan } from "./nativeRenewalOccurrenceWriter.fixture.js";
import { transaction } from "./orderMoneyV2Storage.fixture.js";
import { call, type Db } from "./subscriptionNativeFixture.js";
// A temporary scratch witness at aa98c60ba recorded this HTTP result through the
// PostgreSQL broker: npm run test:hosted -- tests/postgres/privacyReplayFence.test.ts
import previousReplay from "./fixtures/privacyReplayRecorded.json";

const profiles: { profile: AccountProfile; uncarried?: true }[] = [
  { profile: "legacy" }, { profile: "bootstrap" }, { profile: "separate" },
  { profile: "separate", uncarried: true }, { profile: "admin-managed" }, { profile: "admin-operator" },
];
const catalogueForward = "db/platform/migrations/20261127120002_identity_privacy_erasure_reconciliations.sql";
const missingOwner = "customer-saved-addresses";
const coverageCode = "PRIVACY_RECEIPT_COVERAGE_INCOMPLETE";
const missingCode = "PRIVACY_CONTRIBUTOR_MISSING";
const unavailableCode = "PRIVACY_ASSESSMENT_UNAVAILABLE";
const ingresses = ["public", "private", "direct", "package", "retry", "job"] as const;
type Ingress = typeof ingresses[number];
type Operations = identity.PrivacyOperations;
type Operation = "export" | "erase";
type Wire = { status: number; body: {
  ok: boolean; data?: ErasureReceipt; error?: { code: string; details?: Record<string, unknown> };
}; cache?: string };
type Observation = { status: number; outcome?: string; privacyCode?: unknown };
type Runtime = typeof import("../../server/runtime/auth/referenceIdentity.js")
  & typeof import("../../server/runtime/auth/referenceIdentityPolicy.js")
  & typeof import("../../server/runtime/bffDispatch.js")
  & Pick<typeof import("../../server/runtime/auth/privacyBinding.js"), "composeNativePrivacy" | "nativePrivacyContributors">
  & Pick<typeof import("../../server/runtime/auth/subscriptionsPrivacyContributor.js"), "verifyMissingSubscriptionsPrivacySubject">
  & Pick<typeof identity, "createPrivacyOperations" | "createPostgresPrivacyStore" | "createPrivacyExportHandler" | "createPrivacyEraseHandler" | "PrivacyRefusal">;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const unit = (pool: Pool) => identity.createPostgresPrivacyUnitOfWork(
  { connectionString: "postgresql://unused.invalid/fixture" }, { poolFactory: () => pool },
);
const route = (operation: Operation) => `/api/bff/admin/identity/privacy/${operation}`;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let runtime: Runtime, artifact: string, scratch: string;
let packages: Awaited<ReturnType<typeof buildIdentityReferenceRuntime>>;
const artifactDigest = () => hash(readFileSync(artifact));

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "mounted-privacy-"));
  const entry = join(scratch, "entry.ts");
  const output = join(scratch, "build");
  artifact = join(output, "runtime.mjs");
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "dir");
  writeFileSync(entry, [
    ...["referenceIdentity", "referenceIdentityPolicy"].map(name =>
      `export * from ${JSON.stringify(resolve(`server/runtime/auth/${name}.ts`))};`),
    `export { createReferenceBffDispatcher } from ${JSON.stringify(resolve("server/runtime/bffDispatch.ts"))};`,
    `export { composeNativePrivacy, nativePrivacyContributors } from ${JSON.stringify(resolve("server/runtime/auth/privacyBinding.ts"))};`,
    `export { verifyMissingSubscriptionsPrivacySubject } from ${JSON.stringify(resolve("server/runtime/auth/subscriptionsPrivacyContributor.ts"))};`,
    'export { createPrivacyOperations, createPostgresPrivacyStore, createPrivacyExportHandler, createPrivacyEraseHandler, PrivacyRefusal } from "@openlup/platform/identity";',
  ].join("\n"));
  packages = await buildIdentityReferenceRuntime(entry, output);
  runtime = await import(pathToFileURL(artifact).href) as Runtime;
}, postgresSetupTimeoutMs);
afterAll(() => { if (scratch) rmSync(scratch, { force: true, recursive: true }); });

async function seed(db: AccountMutationsStore, uncarried?: true) {
  const actor = { principalId: randomUUID() };
  const subject = { kind: "contact" as const, contactId: randomUUID() };
  const fresh = ingresses.map(() => ({ kind: "contact" as const, contactId: randomUUID() }));
  const erasureId = randomUUID();
  const input = { subject, idempotencyKey: randomUUID() };
  const registry = nativePrivacyContributors(identity.createPostgresPrivacyStore());
  expect(registry.map(owner => owner.id).sort()).toEqual(await identity.readRequiredPrivacyContributorIds(db.runtime));
  const versions = Object.fromEntries(registry.filter(owner => owner.id !== missingOwner).map(owner => [owner.id, owner.version]));
  await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'admin@example.invalid')", [actor.principalId]);
  await db.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES ($1,'admin','active','legacy',now())`, [actor.principalId]);
  await db.owner.query("INSERT INTO public.clients(id,email) VALUES ($1,'prior@example.invalid')", [subject.contactId]);
  await db.owner.query("INSERT INTO public.clients(id,email) SELECT id,id::text||'@example.invalid' FROM unnest($1::uuid[]) AS id",
    [fresh.map(entry => entry.contactId)]);
  await db.owner.query(`INSERT INTO public.customer_saved_addresses(client_id,kind,line1,city,postal_code)
    VALUES ($1,'shipping','Fixture Street','Fixture Town','00000')`, [subject.contactId]);
  await db.owner.query(`INSERT INTO public.identity_privacy_erasures
    (erasure_id,idempotency_key,client_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
    VALUES ($1,$2,$3,$4,'identity.erasure.v1',$5,'[]','[]',now())`,
  [erasureId, input.idempotencyKey, subject.contactId, actor.principalId, versions]);
  if (uncarried) {
    // An installed nonempty relation outside connected capture's carried set.
    const ref = { key: "fixture:repeat", version: 1 };
    const declaration = { ...ref, allowedCadences: [{ schemaVersion: 1, kind: "fixed_days", days: 28 }],
      policyRef: { key: "fixture:policy", version: 1 }, policyDigest: hash("fixture policy") };
    const bytes = canonicalCatalogDraftJson(declaration);
    const manifest = canonicalCatalogDraftJson({ id: "fixture:pack", version: 1, namespace: "fixture", openlupRange: "1.x",
      capabilities: {}, types: [], taxClasses: [], subscriptionProfiles: [ref],
      subscriptionProfileDefinitions: [{ ...declaration, profileDigest: hash(bytes) }] });
    await db.owner.query("SELECT public.catalog_definition_install('fixture:pack',1,$1)", [
      { manifest, types: [], taxClasses: [], profileDeclarationBytes: [bytes] },
    ]);
  }
  return { actor, input, erasureId, fresh };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function state(owner: Pool) {
  // Compare stored bytes in a single read without involving the serving handlers.
  return (await owner.query(`SELECT
    ARRAY(SELECT to_jsonb(t)::text FROM public.clients t ORDER BY id) AS clients,
    ARRAY(SELECT to_jsonb(t)::text FROM public.customer_saved_addresses t ORDER BY client_id) AS addresses,
    ARRAY(SELECT to_jsonb(t)::text FROM public.identity_privacy_erasures t ORDER BY erasure_id) AS receipts,
    ARRAY(SELECT to_jsonb(t)::text FROM public.identity_privacy_erasure_reconciliations t ORDER BY erasure_id,contributor_id) AS approvals,
    ARRAY(SELECT to_jsonb(t)::text FROM public.catalog_subscription_profile_receipts t ORDER BY profile_key,profile_version) AS uncarried`)).rows[0];
}

async function capture(db: AccountMutationsStore, sourceId: string) {
  const client = await db.migrator.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await captureConnectedNativeStore({ sourceId, catalogueId: db.inventory, maximumRows: 10000,
      maximumBytes: 64 * 1024 * 1024, source: { withSnapshot: work => work({
        query: (sql, values) => client.query(sql, values ? [...values] : undefined),
      }) } });
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}

async function captureWithOwner(db: AccountMutationsStore, sourceId: string) {
  if (db.installation.generation !== "qualified-admin") return capture(db, sourceId);
  const login = JSON.stringify(db.installation.migrationLogin);
  await db.owner.query(`GRANT platform_acquisition_owner TO ${login}
    WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY ${login}`);
  try { return await capture(db, sourceId); }
  finally { await db.owner.query(`REVOKE platform_acquisition_owner FROM ${login} GRANTED BY ${login}`); }
}

const databaseName = async (pool: Pool) =>
  (await pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name;

async function stockRestore(source: AccountMutationsStore, target: AccountMutationsStore, container: string) {
  const execPg = (args: string[], input?: Buffer, options: string[] = []) => execFileSync("docker",
    ["exec", "-i", "--user", "postgres", ...options, container, ...args],
    { input, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  const backup = execPg(["pg_dump", "--format=custom", "--dbname", await databaseName(source.owner)]);
  const name = await databaseName(target.owner);
  expect(name).not.toBe(await databaseName(source.owner));
  expect(await target.runner.status()).toEqual(await source.runner.status());
  expect((await state(target.owner)).receipts).toEqual([]);
  // Restore the full data archive into the exact installed schema. PostgreSQL's
  // schema restore normalizes explicitly stored default ACLs and column positions.
  const { rows } = await target.owner.query<{ relation: string }>(`SELECT format('%I.%I', schemaname, tablename) AS relation
    FROM pg_tables WHERE schemaname NOT IN ('information_schema','pg_catalog') ORDER BY 1`);
  await target.owner.query(`BEGIN; SET LOCAL session_replication_role=replica;
    TRUNCATE ${rows.map(row => row.relation).join(",")}; COMMIT`);
  execPg(["pg_restore", "--data-only", "--single-transaction", "--exit-on-error", "--dbname", name], backup,
    ["--env", "PGOPTIONS=-c session_replication_role=replica"]);
  return { target, digest: hash(backup), method: "backup" as const };
}

function operations(db: AccountMutationsStore, fault?: "owner" | "reader", afterDeclaration?: (executor: PgQueryExecutor) => Promise<void>,
  lane = unit(db.runtime), store = runtime.createPostgresPrivacyStore()) {
  if (!fault && !afterDeclaration) return runtime.composeNativePrivacy({ store, unitOfWork: lane }).operations;
  const owners = runtime.nativePrivacyContributors(store);
  const read = store.readRequiredContributorIds.bind(store);
  if (fault === "reader" || afterDeclaration) store.readRequiredContributorIds = async executor => {
    if (fault === "reader") await executor.query("SELECT public.fixture_unavailable_reader()");
    const required = await read(executor);
    await afterDeclaration?.(executor);
    return required;
  };
  const registry = identity.createPersonalDataContributorRegistry(
    owners.filter(owner => fault !== "owner" || owner.id !== missingOwner), { requiredContributorIds: [] },
  );
  return runtime.createPrivacyOperations<PgQueryExecutor>({ store, registry, unitOfWork: lane,
    verifyMissingSubject: runtime.verifyMissingSubscriptionsPrivacySubject, now: () => new Date(), randomId: randomUUID });
}

function mounts(db: AccountMutationsStore, actor: Seed["actor"], privacy = operations(db)) {
  const origin = "http://127.0.0.1:8080";
  const authorize = async () => ({ ...actor, ok: true as const, role: "admin" as const, isMachineActor: false as const });
  const env = { PLATFORM_BUNDLE: "node-postgres" };
  const composed = runtime.createReferenceIdentity({
    bundle: "node-postgres", migrationIdentity: db.inventory, env,
    ports: { privacy, operatorAuthorization: { authorize }, emailTrustPolicy: identity.createVerifierResultOnlyEmailTrustPolicy(),
      customerSession: { verifyAccessToken: vi.fn() }, customerProfile: { getCustomerMe: vi.fn() },
      operatorActions: { inviteAdminUser: vi.fn(), removeAdminUser: vi.fn() }, delivery: { deliver: vi.fn() } },
    createRoutes: () => (["export", "erase"] as const).map(operation => ({
      route: route(operation), pattern: new RegExp(`^${route(operation)}$`), params: [],
      availability: "direct-postgres", handler: () => { throw new Error("Guarded reference handler required"); },
    })),
  });
  const dispatch = runtime.createReferenceBffDispatcher(() => env, composed.preflight);
  const profile = { origin, directory: scratch, bundle: "node-postgres" as const, runId: "disposable",
    async assertOwned() { expect(db.owner.ended).toBe(false); } };
  async function mounted(ingress: Ingress, operation: Operation, input: PrivacyEraseRequest, admitted = true): Promise<Wire> {
    const wire: Wire = { status: 0, body: { ok: false } };
    const req = { method: "POST", url: route(operation), body: operation === "export" ? { subject: input.subject } : input,
      headers: { host: new URL(origin).host, origin, "content-type": "application/json", authorization: "Bearer synthetic" } } as HttpRequest;
    const res = {
      status(code: number) { wire.status = code; return this; },
      json(body: Wire["body"]) { wire.body = body; },
      setHeader(name: string, value: string) { if (name.toLowerCase() === "cache-control") wire.cache = value; },
    } as HttpResponse;
    const invoke = async () => {
      if (ingress === "public") await dispatch(composed.routes, req, res);
      else if (ingress === "private") await composed.routes.find(entry => entry.route === route(operation))!.handler(req, res);
      else await (operation === "export" ? runtime.createPrivacyExportHandler : runtime.createPrivacyEraseHandler)({
        operations: privacy, authorizeAdmin: authorize,
      })(req, res);
    };
    if (admitted) await runtime.withIdentityReferencePolicy(profile, invoke);
    else await invoke();
    return wire;
  }
  const erase = (input: PrivacyEraseRequest) => privacy.erase(actor, input);
  const invoke = (ingress: Ingress, operation: Operation, input: PrivacyEraseRequest) =>
    ingress === "public" || ingress === "private" || ingress === "direct"
      ? mounted(ingress, operation, input)
      : operation === "erase" ? erase(input) : privacy.export(actor, input.subject);
  async function ready() {
    const candidate = { artifact: artifactDigest(), configuration: hash(JSON.stringify(env)), environment: "isolated",
      database: await databaseName(db.runtime), schema: db.inventory };
    return runtime.admitReferenceIdentity({ runtime: composed, candidate, observed: packages,
      currentIdentity: () => ({ ...candidate, artifact: artifactDigest() }),
      schemaProbe: createSchemaProbe({ query: (sql, values) => db.owner.query(sql, [...(values ?? [])]) },
        async () => ({ database: await databaseName(db.owner), version: db.inventory })),
    });
  }
  return { mounted, invoke, erase, ready };
}

function refusal(wire: Wire, code: string): Observation {
  expect(wire).toMatchObject({ status: 503, cache: "no-store", body: { ok: false, error: {
    code: "UPSTREAM_UNAVAILABLE",
    details: { privacyCode: code, observed: expect.any(String), cause: expect.any(String), fix: expect.any(String), recheck: expect.any(String) },
  } } });
  expect(Object.keys(wire.body.error!.details!).sort()).toEqual(["cause", "fix", "observed", "privacyCode", "recheck"]);
  expect(wire.body).not.toHaveProperty("data");
  return { status: wire.status, privacyCode: wire.body.error?.details?.privacyCode };
}

const isHttp = (ingress: Ingress) => ingress === "public" || ingress === "private" || ingress === "direct";

async function refusalThrough(mount: ReturnType<typeof mounts>, ingress: Ingress, operation: Operation, input: PrivacyEraseRequest, code: string) {
  if (isHttp(ingress)) return refusal(await mount.mounted(ingress, operation, input), code);
  const error = await mount.invoke(ingress, operation, input).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(runtime.PrivacyRefusal);
  expect(error).toMatchObject({ code });
  return { status: 503, privacyCode: code };
}

async function eraseThrough(mount: ReturnType<typeof mounts>, ingress: Ingress, input: PrivacyEraseRequest): Promise<ErasureReceipt> {
  if (!isHttp(ingress)) return await mount.invoke(ingress, "erase", input) as ErasureReceipt;
  const result = await mount.mounted(ingress, "erase", input);
  expect(result).toMatchObject({ status: 200, body: { ok: true, data: { erasureId: expect.any(String) } }, cache: "no-store" });
  return result.body.data!;
}

function snapshotRole(db: AccountMutationsStore) {
  return db.runtime.query(`SELECT session_user AS login, current_user AS role,
    has_function_privilege(current_user,'public.identity_privacy_reconciled_contributor_ids(uuid)','EXECUTE') AS replay,
    has_function_privilege(current_user,'public.identity_privacy_required_contributor_ids()','EXECUTE') AS declaration,
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner,
    (SELECT CASE WHEN datacl IS NULL THEN NULL ELSE datacl::text END FROM pg_database WHERE datname=current_database()) AS database_acl`)
    .then(result => result.rows[0]);
}
function oldTransactions(db: AccountMutationsStore) {
  return db.owner.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
    AND backend_type = 'client backend' AND xact_start IS NOT NULL AND pid<>pg_backend_pid() ORDER BY pid`).then(result => result.rows.map(row => row.pid as number));
}

function hostFence() {
  let fenced = false;
  let oldRouted = true;
  const inFlight = new Map<symbol, Ingress>();
  return {
    get paused() { return fenced; },
    get oldExcluded() { return !oldRouted; },
    pause() { fenced = true; },
    retireOld(transactions: readonly number[]) {
      if (!fenced || inFlight.size || transactions.length) return false;
      oldRouted = false;
      return true;
    },
    rollbackToOld(transactions: readonly number[]) {
      if (!fenced || inFlight.size || transactions.length) return false;
      oldRouted = true;
      return true;
    },
    reopen(record: ReturnType<typeof reopenRecord>) {
      if (!record || !fenced || oldRouted || inFlight.size) return false;
      fenced = false;
      return true;
    },
    pending: () => [...inFlight.values()].sort(),
    async admit<T>(ingress: Ingress, work: () => Promise<T>) {
      if (fenced) return "fenced";
      const request = Symbol();
      inFlight.set(request, ingress);
      try { return await work(); } finally { inFlight.delete(request); }
    },
  };
}

type Revisions = Record<string, { digest: string; role: string; coverage: "complete" | "pre-hook" | "declaration-only" }>;
const digestPattern = /^[a-f0-9]{64}$/;
function reopenRecord(evidence: {
  store: string; profile: AccountProfile; inventory: string; forward: string;
  restore: { digest: string; method: "connected" | "backup" };
  tested: Revisions; live: Revisions; census: readonly Ingress[]; pending: readonly Ingress[]; transactions: readonly number[];
  oldExcluded: boolean; fenced: boolean; ready: boolean; approved: boolean;
  probes: { uncovered: readonly Observation[]; recovered: readonly ErasureReceipt[]; exported: number; fresh: readonly ErasureReceipt[]; faults: number };
  original: ErasureReceipt;
}) {
  const { probes, tested, live } = evidence;
  const revisions = Object.keys(tested).sort();
  if (!evidence.approved || !evidence.ready || !evidence.fenced || !evidence.oldExcluded
    || evidence.pending.length || evidence.transactions.length || evidence.census.join() !== ingresses.join()
    || !evidence.store || ![evidence.inventory, evidence.restore.digest].every(value => digestPattern.test(value))
    || evidence.forward !== catalogueForward || !revisions.length || revisions.join() !== Object.keys(live).sort().join()
    || revisions.some(id => !digestPattern.test(tested[id].digest) || tested[id].digest !== live[id].digest
      || !tested[id].role || tested[id].role !== live[id].role || tested[id].coverage !== "complete" || live[id].coverage !== "complete")
    || probes.exported !== ingresses.length || probes.faults !== 4 * ingresses.length
    || probes.fresh.length !== ingresses.length || probes.fresh.some(receipt => receipt.outcome !== "ERASED")
    || new Set(probes.fresh.map(receipt => receipt.erasureId)).size !== ingresses.length
    || probes.uncovered.length !== ingresses.length || probes.recovered.length !== ingresses.length
    || probes.uncovered.some(probe => probe.status !== 503 || probe.privacyCode !== coverageCode || probe.outcome !== undefined)
    || probes.recovered.some(receipt => receipt.erasureId !== evidence.original.erasureId
      || receipt.outcome !== "ALREADY_ERASED" || receipt.completedAt !== evidence.original.completedAt
      || JSON.stringify(receipt.obligations) !== JSON.stringify(evidence.original.obligations))) return null;
  return evidence;
}

it.each(profiles)("rehearses mounted cutover and rollback for $profile (uncarried=$uncarried)", async ({ profile, uncarried }) => {
  const label = "privacy-mount";
  const template = await createAccountMutationsTemplate(profile, label, undefined, undefined, { isolatedCluster: true });
  try {
    const source = await template.clone("source");
    const fixture = await seed(source, uncarried);
    const before = await state(source.owner);
    const installed = await source.runner.status();
    expect(installed.pending).toEqual([]);
    expect(installed.applied).toContain(catalogueForward);
    const role = await snapshotRole(source);
    expect(role).toMatchObject({ login: source.installation.generation === "legacy" ? "postgres" : source.installation.runtimeLogin,
      replay: true, declaration: true });

    const host = hostFence();
    const sourceMounts = mounts(source, fixture.actor);
    const requestHold = barrier();
    const retryHold = barrier();
    const transaction = await source.runtime.connect();
    const request = host.admit("public", async () => { await requestHold.promise; return sourceMounts.invoke("public", "export", fixture.input); });
    const retry = host.admit("retry", async () => { await retryHold.promise; return sourceMounts.invoke("retry", "export", fixture.input); });
    try {
      await transaction.query("BEGIN READ ONLY");
      const pid = (await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      host.pause();
      for (const ingress of ingresses) {
        const blocked = vi.fn(async () => sourceMounts.invoke(ingress, "erase", fixture.input));
        expect(await host.admit(ingress, blocked)).toBe("fenced");
        expect(blocked).not.toHaveBeenCalled();
      }
      for (const operation of ["export", "erase"] as const) {
        expect(await sourceMounts.mounted("public", operation, fixture.input, false)).toMatchObject({
          status: 503, body: { ok: false, error: { details: { reason: "adopter_policy_required" } } },
        });
      }
      expect(host.pending()).toEqual(["public", "retry"]);
      expect(await oldTransactions(source)).toContain(pid);
      expect(host.retireOld(await oldTransactions(source))).toBe(false);
      requestHold.resolve();
      expect(await request).toMatchObject({ status: 200 });
      expect(host.pending()).toEqual(["retry"]);
      retryHold.resolve();
      expect(await retry).toMatchObject({ format: "personal-data.v1" });
      expect(host.pending()).toEqual([]);
      expect(await oldTransactions(source)).toContain(pid);
      expect(host.retireOld(await oldTransactions(source))).toBe(false);
    } finally {
      requestHold.resolve();
      retryHold.resolve();
      try { await transaction.query("ROLLBACK"); } finally { transaction.release(); }
      await Promise.allSettled([request, retry]);
    }
    const drained = await oldTransactions(source);
    expect(drained).toEqual([]);
    expect(host.retireOld(drained)).toBe(true);

    let copy;
    const selection = source.installation;
    if (selection.generation !== "legacy") {
      const packet = await captureWithOwner(source, "source").catch(error => {
        if (!(error instanceof PostgresTransferError)) throw error;
        expect(error).toMatchObject({ code: "subscription_profile_receipts_unsupported", table: "catalog_subscription_profile_receipts" });
        return null;
      });
      expect(packet === null).toBe(uncarried === true);
      if (packet) {
        const target = await template.clone("target");
        const result = await restoreConnectedNativeStore({ owner: target.migrator, installation: selection,
          packet, freshTarget: await captureWithOwner(target, "target") });
        expect(result).toMatchObject({ captureSha256: packet.sha256, replayed: false });
        copy = { target, digest: result.captureSha256, method: "connected" as const };
      }
    }
    if (!copy) {
      copy = await stockRestore(source, await template.clone("backup"), `account-mutations-tpl-${profile}-${label}-${process.pid}`);
    }
    const target = copy.target;
    expect(copy.method).toBe(profile === "legacy" || uncarried ? "backup" : "connected");
    expect(await state(target.owner)).toEqual(before);
    expect(await target.runner.status()).toEqual(installed);
    expect(await snapshotRole(target)).toEqual(role);
    if (uncarried) expect(before.uncarried).toHaveLength(1);
    const serving = mounts(target, fixture.actor);
    const shadow = await serving.ready();
    expect(shadow.admitted, JSON.stringify(shadow.report.issues)).toBe(true);
    shadow.assertCurrent();
    const revision = (): Revisions[string] => ({ digest: artifactDigest(), role: role.login, coverage: "complete" });
    const tested = { public: revision(), private: revision() };
    const originalRow = JSON.parse(before.receipts[0]);
    const original: ErasureReceipt = {
      version: originalRow.contract_version, erasureId: originalRow.erasure_id,
      completedAt: new Date(originalRow.completed_at).toISOString(), obligations: originalRow.retained_obligations,
      outcome: "ALREADY_ERASED",
    };
    expect(original.erasureId).toBe(fixture.erasureId);
    const uncovered: Observation[] = [];
    for (const ingress of ingresses) {
      const result = await serving.invoke(ingress, "export", fixture.input);
      if ("status" in result) expect(result).toMatchObject({ status: 200, body: { ok: true }, cache: "no-store" });
      else expect(result).toMatchObject({ format: "personal-data.v1", subject: fixture.input.subject });
      uncovered.push(await refusalThrough(serving, ingress, "erase", fixture.input, coverageCode));
    }
    let faults = 0;
    for (const [fault, code] of [["owner", missingCode], ["reader", unavailableCode]] as const) {
      const faulty = mounts(target, fixture.actor, operations(target, fault));
      for (const ingress of ingresses) {
        for (const operation of ["export", "erase"] as const) {
          await refusalThrough(faulty, ingress, operation, fixture.input, code);
          faults++;
        }
      }
    }
    expect(await state(target.owner)).toEqual(before);
    const registry = identity.createPersonalDataContributorRegistry(nativePrivacyContributors(identity.createPostgresPrivacyStore()), { requiredContributorIds: [] });
    const approval = { erasure_id: fixture.erasureId, contributor_id: missingOwner, evidence_ref: randomUUID() };
    const context = { registry, actor: fixture.actor, unitOfWork: unit(target.migrator) };
    if (profile !== "legacy") await expect(identity.reconcilePostgresPrivacyErasure({ ...context, unitOfWork: unit(target.runtime) }, approval))
      .rejects.toMatchObject({ code: unavailableCode });
    await expect(identity.reconcilePostgresPrivacyErasure(context, approval)).resolves.toMatchObject({ contributorId: missingOwner });
    const recovered = await Promise.all(ingresses.map(ingress => eraseThrough(serving, ingress, fixture.input)));
    const after = await state(target.owner);
    expect(after).toMatchObject({ clients: before.clients, receipts: before.receipts, addresses: [], uncarried: before.uncarried });
    expect(after.approvals).toHaveLength(1);
    const fresh: ErasureReceipt[] = [];
    for (const [index, ingress] of ingresses.entries()) {
      fresh.push(await eraseThrough(serving, ingress, { subject: fixture.fresh[index]!, idempotencyKey: randomUUID() }));
    }

    const liveAdmission = await sourceMounts.ready();
    expect(liveAdmission.admitted, JSON.stringify(liveAdmission.report.issues)).toBe(true);
    liveAdmission.assertCurrent();
    expect(await source.runner.status()).toEqual(installed);
    expect(await snapshotRole(source)).toEqual(role);
    expect(await state(source.owner)).toEqual(before);
    const evidence = {
      store: await databaseName(source.runtime), profile, inventory: source.inventory, forward: catalogueForward,
      restore: { digest: copy.digest, method: copy.method },
      tested, live: { public: revision(), private: revision() }, census: ingresses, oldExcluded: host.oldExcluded,
      fenced: host.paused, ready: liveAdmission.admitted, approved: true, pending: host.pending(), transactions: await oldTransactions(source),
      probes: { uncovered, recovered, exported: ingresses.length, fresh, faults }, original,
    };
    expect(previousReplay).toMatchObject({ status: 200, outcome: "ALREADY_ERASED" });
    expect(previousReplay.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    for (const bad of [previousReplay, { status: 503, privacyCode: unavailableCode }, { status: 409, privacyCode: coverageCode }]) {
      expect(reopenRecord({ ...evidence, probes: { ...evidence.probes, uncovered: [bad, ...uncovered.slice(1)] } })).toBeNull();
    }
    for (const exclusion of [
      { approved: false }, { oldExcluded: false }, { pending: ["retry"] as const }, { transactions: [1] },
      { live: { public: revision() } }, { live: { ...evidence.live, public: { ...revision(), digest: hash("other build") } } },
      ...(["pre-hook", "declaration-only"] as const).map(coverage => ({ live: {
        ...evidence.live, private: { ...revision(), coverage },
      } })),
    ]) expect(reopenRecord({ ...evidence, ...exclusion })).toBeNull();
    const record = reopenRecord(evidence);
    expect(record).toBe(evidence);
    expect(host.reopen(record)).toBe(true);

    // Refence with an aware request holding its original declaration in a real transaction.
    const declarationRead = barrier();
    const finish = barrier();
    const aware = mounts(target, fixture.actor, operations(target, undefined, async () => {
      declarationRead.resolve();
      await finish.promise;
    }));
    const overlapping = host.admit("private", () => aware.mounted("private", "export", fixture.input));
    try {
      await Promise.race([declarationRead.promise, overlapping.then(() => { throw new Error("Declaration barrier was bypassed"); })]);
      host.pause();
      expect(host.pending()).toEqual(["private"]);
      const transactions = await oldTransactions(target);
      expect(transactions).toHaveLength(1);
      expect(reopenRecord({ ...evidence, pending: host.pending(), transactions })).toBeNull();
      expect(host.rollbackToOld(transactions)).toBe(false);
      await target.owner.query("INSERT INTO public.identity_privacy_required_contributors(contributor_id) VALUES ('fixture-appended-owner')");
      expect(await host.admit("retry", () => serving.erase(fixture.input))).toBe("fenced");
    } finally { finish.resolve(); await overlapping; }
    expect(await overlapping).toMatchObject({ status: 200 });
    expect(host.pending()).toEqual([]);
    const rollbackDrain = await oldTransactions(target);
    expect(rollbackDrain).toEqual([]);
    expect(host.rollbackToOld(rollbackDrain)).toBe(true);
    refusal(await serving.mounted("private", "export", fixture.input), missingCode);
    expect(await identity.readRequiredPrivacyContributorIds(target.runtime)).toContain("fixture-appended-owner");
    expect(host.reopen(reopenRecord({ ...evidence, oldExcluded: host.oldExcluded, ready: false }))).toBe(false);
    expect(host.paused).toBe(true);
    expect(await state(source.owner)).toEqual(before);
    expect(await target.runner.status()).toEqual(installed);
  } finally {
    await template.close();
  }
}, postgresSetupTimeoutMs);

const occurrenceHelper = "public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid)";
const privacyForward = occurrenceForwardPath(occurrenceHelper);
const privacyPlan = sliceOccurrencePlan(occurrenceCatalogue, privacyForward, true);
const retention = { owner: "subscriptions", resource: "subscriptions.occurrence-evidence", disposition: "retain",
  reasonCode: "RENEWAL_OCCURRENCE_RETENTION", remote: false };
const retained = (list: unknown[]) => list.filter(value => (value as { resource?: string })?.resource === retention.resource);
const erasedRenewal = { code: "22023", message: "renewal_cycle_unavailable", detail: "/cycleKey privacy_erased" };
const inputFor = (contactId: string): PrivacyEraseRequest => ({ subject: { kind: "contact", contactId }, idempotencyKey: randomUUID() });
const defaults = ["READ COMMITTED", "REPEATABLE READ"] as const;
const rc = (db: PoolClient) => db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
const pidOf = async (db: { query(sql: string): Promise<{ rows: Record<string, unknown>[] }> }) =>
  Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
const codeAt = (wire: Wire, code: string) => expect(wire.body).toMatchObject({ ok: false, error: { details: { privacyCode: code } } });

async function privacyActor(db: Db) {
  const principalId = randomUUID();
  await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1::uuid,$1::uuid::text||'@example.invalid')", [principalId]);
  await db.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES ($1,'admin','active','legacy',now())`, [principalId]);
  return { principalId };
}

async function contact(db: Db, principalId: string | null = null) {
  const id = randomUUID();
  await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES ($1::uuid,$1::uuid::text||'@example.invalid',$2)", [id, principalId]);
  return inputFor(id);
}

async function cancelOccurrence(db: Db, f: { clientId: string; subscriptionId: string }, actor: string) {
  const key = randomUUID();
  const { at } = (await db.query(`SELECT coalesce(max(lease_expires_at) + interval '1 microsecond', clock_timestamp())::text AS at
    FROM public.subscription_renewal_operations WHERE subscription_id = $1`, [f.subscriptionId])).rows[0];
  expect(await call(db, "subscription_command_apply", [actor, f.clientId, key, f.subscriptionId, "cancel", {}, at]))
    .toMatchObject({ status: "applied", subscriptionStatus: "cancelled" });
  return key;
}

async function verifyCancellation(db: Db, f: { subscriptionId: string }, key: string) {
  expect((await db.query(`SELECT s.status AS parent,r.status,r.command->>'action' AS action
    FROM public.subscriptions s JOIN public.subscription_command_receipts r ON r.subscription_id=s.id
    WHERE s.id=$1 AND r.idempotency_key=$2`, [f.subscriptionId, key])).rows).toEqual([{ parent: "cancelled", status: "applied", action: "cancel" }]);
}

async function selectRoot(db: Db, f: Awaited<ReturnType<typeof rootFixture>>) {
  const result = await call(db, writer, args(f));
  expect(result).toMatchObject({ outcome: "created", cycleKey: f.cycleKey, originalAnchorAt: f.originalAnchorAt,
    operationId: f.agreement.operationId, commercialGenerationId: f.agreement.operationId, claimToken: expect.any(String) });
  return result;
}

async function persistRoot(owner: Pool, f: Awaited<ReturnType<typeof rootFixture>>) {
  const result = await transaction(owner, async db => { await rc(db); return selectRoot(db, f); });
  expect((await owner.query(`SELECT o.operation_id,o.commercial_generation_id,g.claim_token,
    to_char(g.lease_expires_at AT TIME ZONE 'UTC',${utc}) AS expires,g.lease_generation::int AS generation
    FROM public.${occurrence} o JOIN public.subscription_renewal_operations r ON r.id=o.operation_id
    JOIN public.subscription_cycle_generations g ON g.operation_id=r.id AND g.claim_token=r.claim_token
      AND g.lease_expires_at=r.lease_expires_at WHERE o.cycle_key=$1 AND r.scheduled_at=o.original_anchor_at`, [f.cycleKey])).rows)
    .toEqual([{ operation_id: result.operationId, commercial_generation_id: result.operationId,
      claim_token: result.claimToken, expires: result.leaseExpiresAt, generation: 1 }]);
}

async function receiptRetention(db: Db, receipt: ErasureReceipt, expected = [retention]) {
  expect(retained(receipt.obligations)).toEqual(expected);
  const { rows: [row] } = await db.query(`SELECT retained_obligations, dispositions FROM public.identity_privacy_erasures
    WHERE erasure_id=$1`, [receipt.erasureId]);
  expect(retained(row.retained_obligations)).toEqual(expected);
  expect(retained(row.dispositions.find((d: { contributorId: string }) => d.contributorId === "subscriptions").obligations)).toEqual(expected);
}

async function readExport(mount: ReturnType<typeof mounts>, input: PrivacyEraseRequest) {
  const wire = await mount.mounted("public", "export", input);
  expect(wire).toMatchObject({ status: 200, cache: "no-store", body: { ok: true } });
  return wire.body.data as unknown as PrivacyExport;
}

function checkProjection(exported: PrivacyExport, f: { subscriptionId: string; cycleKey: string; originalAnchorAt: string }) {
  const document = exported.documents.find(entry => entry.contributorId === "subscriptions");
  expect(document).toMatchObject({ version: "subscriptions.privacy-veto.v1",
    coverage: { complete: false, included: ["subscription IDs and statuses", "renewal occurrence evidence"],
      unavailable: ["full subscription export", "processor obligations"] } });
  expect(document?.renewalOccurrences).toEqual([{ subscriptionId: f.subscriptionId, cycleKey: f.cycleKey,
    rail: "v3", lifecycle: "active", originalAnchorAt: f.originalAnchorAt, effectiveDueAt: f.originalAnchorAt, cancellationEffectiveAt: null }]);
  expect(retained(document!.obligations)).toEqual([retention]);
  expect(exported.documents.find(entry => entry.contributorId === "customer-preferences")?.data).toEqual({ payment: [], delivery: [] });
}

async function checkPrivacyAcl(db: AccountMutationsStore) {
  const { rows: [acl] } = await db.owner.query(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
    p.proconfig AS settings, p.proowner=c.relowner AS owns_carrier, to_regrole('service_role') IS NOT NULL AS service,
    ARRAY(SELECT coalesce(r.rolname::text,'PUBLIC') FROM aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee
      WHERE a.privilege_type='EXECUTE' ORDER BY 1) AS roles,
    ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.rolname IN ('anon','authenticated')
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS forbidden
    FROM pg_proc p, pg_class c WHERE p.oid=$1::regprocedure AND c.oid='public.subscription_cycle_occurrences'::regclass`, [occurrenceHelper]);
  expect(acl).toMatchObject({ definer: true, owns_carrier: true, settings: ["row_security=off", "search_path=pg_catalog, pg_temp"], forbidden: [] });
  expect(acl.roles).toEqual([acl.owner, ...(acl.service ? ["service_role"] : [])].sort());
  expect((await db.runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS helper", [occurrenceHelper])).rows[0].helper).toBe(true);
  if (db.installation.generation !== "legacy") await transaction(db.runtime, async lane => {
    await lane.query("SET LOCAL ROLE service_role");
    expect((await lane.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS helper", [occurrenceHelper])).rows[0].helper).toBe(true);
  });
}

it.each(["legacy", "legacy-with-service", "bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "upgrades the measured writer prefix and retains scoped occurrence evidence on %s", async variant => {
    const db = await installMeasuredAccountPrefix(writerPlan(), variant, "privacy-upgrade");
    try {
      const actor = await privacyActor(db.owner);
      const empty = await contact(db.owner);
      const f = await rootFixture(db.migrator);
      const subject = inputFor(f.clientId);
      const mounted = mounts(db, actor);
      await persistRoot(db.migrator, f);
      await verifyCancellation(db.owner, f, await cancelOccurrence(db.migrator, f, actor.principalId));
      const before = await state(db.owner);
      for (const input of [empty, subject]) for (const operation of ["export", "erase"] as const) {
        refusal(await mounted.mounted("public", operation, input), unavailableCode);
      }
      expect(await state(db.owner)).toEqual(before);

      await applyMeasuredOccurrencePrefix(privacyPlan, db.migrator, db.installation,
        variant === "legacy-with-service" ? "legacy" : variant, [privacyForward]);
      await checkPrivacyAcl(db);
      const exported = await readExport(mounted, subject);
      checkProjection(exported, f);
      expect(exported.documents.find(d => d.contributorId === "subscriptions")?.data).toEqual([{ id: f.subscriptionId, status: "cancelled" }]);
      const scopedEmpty = await readExport(mounted, empty);
      expect(scopedEmpty.documents.find(d => d.contributorId === "subscriptions")).toMatchObject({ data: [],
        coverage: { complete: false, included: ["subscription IDs and statuses"] } });
      expect(scopedEmpty.documents.find(d => d.contributorId === "subscriptions")).not.toHaveProperty("renewalOccurrences");
      const profile = variant === "legacy-with-service" ? "legacy" : variant;
      if (profile !== "legacy") await db.owner.query("REVOKE EXECUTE ON FUNCTION public.customer_preferences_export(uuid) FROM service_role");
      const candidateEmpty = await eraseThrough(mounted, "public", empty);
      await receiptRetention(db.owner, candidateEmpty, []);
      if (profile !== "legacy") {
        const baseline = await installMeasuredAccountPrefix(sliceOccurrencePlan(occurrenceCatalogue,
          "db/platform/migrations/20261129130001_native_renewal_v3_storage.sql", false), profile, "privacy-before-occurrences");
        try {
          await baseline.owner.query("REVOKE EXECUTE ON FUNCTION public.customer_preferences_export(uuid) FROM service_role");
          const baselineEmpty = await eraseThrough(mounts(baseline, await privacyActor(baseline.owner)), "public", await contact(baseline.owner));
          expect(candidateEmpty).toEqual({ ...baselineEmpty, erasureId: candidateEmpty.erasureId, completedAt: candidateEmpty.completedAt });
          await receiptRetention(baseline.owner, baselineEmpty, []);
        } finally { await baseline.close(); }
      }
      const receipt = await eraseThrough(mounted, "public", subject);
      await receiptRetention(db.owner, receipt);
      const stored = await state(db.owner);
      expect(await eraseThrough(mounted, "public", subject)).toEqual({ ...receipt, outcome: "ALREADY_ERASED" });
      expect(await state(db.owner)).toEqual(stored);
      await expect(call(db.migrator, writer, args(f))).rejects.toMatchObject(erasedRenewal);
      await expect(call(db.migrator, writer, args(f, { altered: true }))).rejects.toMatchObject(erasedRenewal);
      if (variant === "admin-managed") {
        await db.owner.query("ALTER TABLE public.identity_privacy_erasures FORCE ROW LEVEL SECURITY");
        try {
          const unavailable = { ...erasedRenewal, detail: "/cycleKey privacy_evidence_unavailable" };
          await expect(call(db.migrator, writer, args(f))).rejects.toMatchObject(unavailable);
          await expect(allocate(db.migrator, f)).rejects.toMatchObject(unavailable);
        } finally { await db.owner.query("ALTER TABLE public.identity_privacy_erasures NO FORCE ROW LEVEL SECURITY"); }
      }
    } finally { await db.close(); }
  }, postgresSetupTimeoutMs);

async function atDefault(db: AccountMutationsStore, isolation: typeof defaults[number], work: (store: AccountMutationsStore) => Promise<void>) {
  const runtime = new Pool({ connectionString: db.runtime.options.connectionString, max: 1 });
  try {
    await runtime.query(`SET default_transaction_isolation TO '${isolation}'`);
    await work({ ...db, runtime });
  } finally { await runtime.end(); }
}

async function withPrivacyStore(work: (store: AccountMutationsStore) => Promise<void>) {
  const db = await installMeasuredAccountPrefix(privacyPlan, "bootstrap", "occurrence-privacy");
  try { await work(db); } finally { await db.close(); }
}

const holdReached = (reached: ReturnType<typeof barrier>, pending: Promise<unknown>) =>
  Promise.race([reached.promise, pending.then(result => { throw new Error(`Mounted request missed its barrier: ${JSON.stringify(result)}`); })]);

async function waitForBlock(db: Pool, waiting: number, blocking: number) {
  await expect.poll(async () => (await db.query("SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked",
    [waiting, blocking])).rows[0].blocked, { timeout: 3000 }).toBe(true);
}

it.each(defaults)("preserves producer-only evidence and the mounted snapshot under %s defaults", isolation => withPrivacyStore(db =>
  atDefault(db, isolation, async serving => {
    const actor = await privacyActor(db.owner);
    const mounted = mounts(serving, actor);
    const f = await paidRootFixture(db.migrator);
    const producerOnly = await committedAllocation(db.migrator, f, "v3");
    const subject = inputFor(f.clientId);
    checkProjection(await readExport(mounted, subject), { ...f, ...producerOnly });
    const pair = () => db.owner.query(`SELECT operation_id,commercial_generation_id,
      (SELECT count(*)::int FROM public.subscription_renewal_operations WHERE subscription_id=$1) AS roots
      FROM public.${occurrence} WHERE cycle_key=$2`, [f.subscriptionId, producerOnly.cycleKey]).then(r => r.rows);
    const unselected = [{ operation_id: null, commercial_generation_id: null, roots: 0 }];
    expect(await pair()).toEqual(unselected);
    await verifyCancellation(db.owner, f, await cancelOccurrence(db.migrator, f, actor.principalId));
    const second = await activation(db.migrator, 7, undefined, f.clientId);
    const another = await transaction(db.migrator, async lane => { await rc(lane); return allocate(lane, second); });
    const cancelled = await cancelOccurrence(db.migrator, second, actor.principalId);
    await verifyCancellation(db.owner, second, cancelled);
    // Represent a later lifecycle transition on a committed allocation and cancellation.
    const { rows: [transition] } = await db.migrator.query(`UPDATE public.${occurrence} o
      SET lifecycle='stopped',is_current=false,cancellation_receipt_id=r.id,cancellation_effective_at=s.ended_at
      FROM public.subscription_command_receipts r JOIN public.subscriptions s ON s.id=r.subscription_id
      WHERE r.idempotency_key=$1 AND o.cycle_key=$2 AND s.id=o.subscription_id
      RETURNING to_char(o.cancellation_effective_at AT TIME ZONE 'UTC',${utc}) AS at`, [cancelled, another.cycleKey]);
    const both = (await readExport(mounted, subject)).documents.find(d => d.contributorId === "subscriptions")!;
    expect(both.renewalOccurrences?.map(row => row.subscriptionId)).toEqual([f.subscriptionId, second.subscriptionId].sort());
    expect(both.renewalOccurrences?.find(row => row.cycleKey === another.cycleKey)).toMatchObject({ lifecycle: "stopped", cancellationEffectiveAt: transition.at });
    expect(retained(both.obligations)).toEqual([retention]);
    await receiptRetention(db.owner, await eraseThrough(mounted, "public", subject));
    expect(await pair()).toEqual(unselected);

    const read = barrier(), finish = barrier();
    let pending!: Promise<Wire>;
    const snapshot = mounts(serving, actor, operations(serving, undefined, async lane => {
      expect((await lane.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("read committed");
      read.resolve();
      await finish.promise;
    }));
    const selected = await rootFixture(db.migrator, "v3", original, async (owner, paid) => {
      expect((await owner.query(`SELECT 1 FROM public.${occurrence} WHERE subscription_id=$1`, [paid.subscriptionId])).rows).toEqual([]);
      pending = snapshot.mounted("public", "erase", inputFor(paid.clientId));
      await holdReached(read, pending);
    }).catch(async error => { finish.resolve(); await pending; throw error; });
    try {
      await persistRoot(db.migrator, selected);
      await verifyCancellation(db.owner, selected, await cancelOccurrence(db.migrator, selected, actor.principalId));
    } finally { finish.resolve(); await pending; }
    const response = await pending;
    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    const receipt = response.body.data!;
    await receiptRetention(db.owner, receipt);

    const newSubject = await contact(db.owner);
    const inStaleTransaction = async <T,>(pool: Pool, work: (db: PgQueryExecutor) => Promise<T>) => transaction(pool, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await db.query("SELECT count(*) FROM public.clients");
      return work(db);
    });
    const stale = mounts(serving, actor, operations(serving, undefined, undefined, {
      run: work => inStaleTransaction(serving.runtime, work), close: async () => {},
    }));
    const before = await state(db.owner);
    refusal(await stale.mounted("public", "erase", newSubject), unavailableCode);
    expect(await state(db.owner)).toEqual(before);

    const store = identity.createPostgresPrivacyStore();
    const registry = identity.createPersonalDataContributorRegistry(nativePrivacyContributors(store), { requiredContributorIds: [] });
    const approval = { erasure_id: receipt.erasureId, contributor_id: "subscriptions", evidence_ref: randomUUID() };
    const approvalContext = { actor, registry, unitOfWork: unit(db.migrator) };
    await expect(identity.reconcilePostgresPrivacyErasure({
      ...approvalContext, unitOfWork: { run: work => inStaleTransaction(db.migrator, work) },
    }, approval)).rejects.toMatchObject({ code: unavailableCode });
    expect(await state(db.owner)).toEqual(before);
    const disposition = await identity.reconcilePostgresPrivacyErasure(approvalContext, approval);
    expect(retained(disposition!.obligations)).toEqual([retention]);
    expect((await state(db.owner)).receipts).toEqual(before.receipts);
    await expect(identity.reconcilePostgresPrivacyErasure(approvalContext, approval)).resolves.toBeNull();
  })), postgresSetupTimeoutMs);

it.each(defaults)("orders the owner fences and mounted erase under %s defaults", isolation => withPrivacyStore(db =>
  atDefault(db, isolation, async serving => {
    const actor = await privacyActor(db.owner);
    for (const retain of [false, true]) {
      const f = await rootFixture(db.migrator);
      const read = barrier();
      let waiter = 0, pending!: Promise<Wire>, cancellation = "";
      const mounted = mounts(serving, actor, operations(serving, undefined, async lane => {
        waiter = await pidOf(lane); read.resolve();
      }));
      try {
        await transaction(db.migrator, async owner => {
          await rc(owner);
          if (retain) await owner.query("LOCK TABLE public.subscriptions IN ROW EXCLUSIVE MODE");
          else await selectRoot(owner, f);
          pending = mounted.mounted("public", "erase", inputFor(f.clientId));
          await holdReached(read, pending);
          await waitForBlock(db.owner, waiter, await pidOf(owner));
          if (retain) {
            await selectRoot(owner, f);
            cancellation = await cancelOccurrence(owner, f, actor.principalId);
          }
        });
      } finally { await pending; }
      const response = await pending;
      if (retain) {
        expect(response.status).toBe(200);
        await verifyCancellation(db.owner, f, cancellation);
        await receiptRetention(db.owner, response.body.data!);
      } else {
        codeAt(response, "PRIVACY_ACTIVE_SUBSCRIPTION");
        expect((await db.owner.query("SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=$1", [f.clientId])).rows).toEqual([]);
      }
    }

    for (const selected of [false, true]) {
      const root = selected ? await rootFixture(db.migrator) : null;
      const f = root ?? await paidRootFixture(db.migrator);
      const ownerCall = (owner: Db) => root ? call(owner, writer, args(root)) : allocate(owner, f);
      if (root) {
        await persistRoot(db.migrator, root);
        await expect(ownerCall(db.migrator)).resolves.toMatchObject({ outcome: "existing", claimToken: null });
      }
      await verifyCancellation(db.owner, f, await cancelOccurrence(db.migrator, f, actor.principalId));
      const before = await db.owner.query(`SELECT to_jsonb(o) AS row,xmin::text FROM public.${occurrence} o WHERE subscription_id=$1`, [f.subscriptionId]);
      const save = barrier(), finish = barrier(), store = runtime.createPostgresPrivacyStore();
      const original = store.saveReceipt.bind(store);
      let eraser = 0;
      store.saveReceipt = async (...parameters) => {
        eraser = await pidOf(parameters[0]); save.resolve(); await finish.promise;
        return original(...parameters);
      };
      const mounted = mounts(serving, actor, operations(serving, undefined, undefined, unit(serving.runtime), store));
      const request = mounted.mounted("public", "erase", inputFor(f.clientId));
      const caller = await db.migrator.connect();
      try {
        await holdReached(save, request);
        await caller.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const waiting = await pidOf(caller);
        const invocation = ownerCall(caller).catch((error: unknown) => error);
        await waitForBlock(db.owner, waiting, eraser);
        expect((await db.owner.query(`SELECT relation FROM pg_locks WHERE pid=$1
          AND relation IN ('public.subscription_cycle_occurrences'::regclass, 'public.subscription_cycle_generations'::regclass)`, [waiting])).rows)
          .toEqual([]);
        finish.resolve();
        expect((await request).status).toBe(200);
        expect(await invocation).toMatchObject(erasedRenewal);
        expect((await db.owner.query(`SELECT to_jsonb(o) AS row,xmin::text FROM public.${occurrence} o WHERE subscription_id=$1`, [f.subscriptionId])).rows)
          .toEqual(before.rows);
      } finally {
        finish.resolve();
        try { await caller.query("ROLLBACK"); } finally { caller.release(); await request; }
      }
    }

    const store = runtime.createPostgresPrivacyStore(), resolved = barrier(), release = barrier();
    const resolveSubject = store.resolve.bind(store);
    let eraser = 0;
    store.resolve = async (...parameters) => {
      const subject = await resolveSubject(...parameters);
      eraser = await pidOf(parameters[0]); resolved.resolve();
      await release.promise;
      return subject;
    };
    const mounted = mounts(serving, actor, operations(serving, undefined, undefined, unit(serving.runtime), store));
    let request!: Promise<Wire>;
    const f = await rootFixture(db.migrator, "v3", original, async (owner, paid) => {
      request = mounted.mounted("public", "erase", inputFor(paid.clientId));
      await holdReached(resolved, request);
      await expect(transaction(owner, async lane => {
        await rc(lane);
        await lane.query("SET LOCAL lock_timeout = '100ms'");
        return allocate(lane, paid, "v3", { ...defaultRule, leadSeconds: 0 });
      })).rejects.toMatchObject({ code: "55P03" });
    }, (owner, paid, rail) => committedAllocation(owner, paid, rail, async (lane, scope, rail, policy) => {
      const waiting = await pidOf(lane);
      const allocation = allocate(lane, scope, rail, policy);
      try { await waitForBlock(db.owner, waiting, eraser); }
      finally { release.resolve(); }
      return allocation;
    })).finally(async () => { release.resolve(); await request; });
    codeAt(await request, "PRIVACY_ACTIVE_SUBSCRIPTION");
    await persistRoot(db.migrator, f);
  })), postgresSetupTimeoutMs);

it("uses the original RLS-bound login for fresh scope and fails closed without supported EXECUTE", () => withPrivacyStore(async db => {
  const actor = await privacyActor(db.owner);
  const f = await rootFixture(db.migrator);
  await persistRoot(db.migrator, f);
  const subject = inputFor(f.clientId), empty = await contact(db.owner);
  await verifyCancellation(db.owner, f, await cancelOccurrence(db.migrator, f, actor.principalId));
  const unlinked = randomUUID();
  await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'unlinked@example.invalid')", [unlinked]);
  const principalInput = { subject: { kind: "principal" as const, principalId: unlinked }, idempotencyKey: randomUUID() };
  const linked = await contact(db.owner, unlinked);
  const customerPrincipal = randomUUID();
  await contact(db.owner, customerPrincipal);
  const mounted = mounts(db, actor);
  checkProjection(await readExport(mounted, subject), f);
  await db.owner.query(`CREATE POLICY fixture_hide_link ON public.clients AS RESTRICTIVE FOR SELECT TO service_role
    USING (principal_id IS DISTINCT FROM '${unlinked}'::uuid AND principal_id IS DISTINCT FROM '${customerPrincipal}'::uuid)`);
  for (const operation of ["export", "erase"] as const) {
    refusal(await mounted.mounted("public", operation, principalInput), unavailableCode);
    refusal(await mounted.mounted("public", operation, { ...principalInput, subject: { kind: "principal", principalId: customerPrincipal } }), unavailableCode);
    codeAt(await mounted.mounted("public", operation, inputFor(randomUUID())), "PRIVACY_SUBJECT_NOT_FOUND");
  }
  await db.owner.query("DROP POLICY fixture_hide_link ON public.clients");
  expect((await readExport(mounted, principalInput)).documents.find(d => d.contributorId === "customer-preferences")?.data)
    .toEqual({ payment: [], delivery: [] });

  await db.owner.query(`CREATE POLICY fixture_hide_occurrence ON public.${occurrence} AS RESTRICTIVE FOR SELECT TO service_role
    USING (client_id <> '${f.clientId}'::uuid)`);
  const parentOnly = await activation(db.migrator);
  const before = await state(db.owner);
  for (const operation of ["export", "erase"] as const) refusal(await mounted.mounted("public", operation, subject), unavailableCode);
  expect(await state(db.owner)).toEqual(before);
  await db.owner.query(`DROP POLICY fixture_hide_occurrence ON public.${occurrence}`);
  await db.owner.query(`ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_hide_parent ON public.subscriptions FOR SELECT TO service_role USING (id <> '${parentOnly.subscriptionId}'::uuid)`);
  refusal(await mounted.mounted("public", "erase", inputFor(parentOnly.clientId)), unavailableCode);
  await db.owner.query("DROP POLICY fixture_hide_parent ON public.subscriptions; ALTER TABLE public.subscriptions DISABLE ROW LEVEL SECURITY");

  const { definition } = (await db.owner.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [occurrenceHelper])).rows[0];
  for (const mutation of ["RAISE EXCEPTION 'fixture unavailable';", "RETURN '{}'::jsonb;"]) {
    await db.owner.query(definition.replace(/\nBEGIN\n/u, `\nBEGIN\n  ${mutation}\n`));
    refusal(await mounted.mounted("public", "export", subject), unavailableCode);
    refusal(await mounted.mounted("public", "erase", subject), unavailableCode);
    expect(await state(db.owner)).toEqual(before);
  }
  await db.owner.query(definition);
  await db.owner.query(`REVOKE EXECUTE ON FUNCTION ${occurrenceHelper} FROM service_role`);
  refusal(await mounted.mounted("public", "erase", empty), unavailableCode);
  for (const operation of ["export", "erase"] as const) {
    codeAt(await mounted.mounted("public", operation, inputFor(randomUUID())), "PRIVACY_SUBJECT_NOT_FOUND");
  }
  const protectedSubject = { subject: { kind: "principal" as const, principalId: actor.principalId }, idempotencyKey: randomUUID() };
  refusal(await mounted.mounted("public", "erase", protectedSubject), unavailableCode);
  expect(await state(db.owner)).toEqual(before);
  await db.owner.query(`GRANT EXECUTE ON FUNCTION ${occurrenceHelper} TO service_role`);
  codeAt(await mounted.mounted("public", "erase", protectedSubject), "PRIVACY_PROTECTED_OPERATOR");
  checkProjection(await readExport(mounted, subject), f);
  await db.owner.query("REVOKE EXECUTE ON FUNCTION public.customer_preferences_prepare_erasure() FROM service_role");
  checkProjection(await readExport(mounted, subject), f);
  refusal(await mounted.mounted("public", "erase", subject), unavailableCode);
  await db.owner.query("GRANT EXECUTE ON FUNCTION public.customer_preferences_prepare_erasure() TO service_role");

  await db.owner.query("CREATE ROLE fixture_custom_eraser NOLOGIN");
  await db.owner.query("GRANT USAGE ON SCHEMA public TO fixture_custom_eraser");
  await db.owner.query(`GRANT EXECUTE ON FUNCTION public.customer_preferences_prepare_erasure() TO fixture_custom_eraser`);
  await db.owner.query(`GRANT EXECUTE ON FUNCTION public.identity_privacy_required_contributor_ids(),
      public.customer_preferences_export(uuid) TO fixture_custom_eraser;
    GRANT SELECT ON public.clients, public.subscriptions, public.identity_privacy_erasures, public.platform_human_principals,
      public.client_absorption_policy, public.platform_schema_migrations TO fixture_custom_eraser;
    GRANT SELECT (client_id) ON public.subscription_cycle_occurrences TO fixture_custom_eraser;
    CREATE POLICY fixture_custom_client ON public.clients FOR SELECT TO fixture_custom_eraser USING (true);
    CREATE POLICY fixture_custom_catalogue ON public.client_absorption_policy FOR SELECT TO fixture_custom_eraser USING (true);
    CREATE POLICY fixture_custom_receipt ON public.identity_privacy_erasures FOR SELECT TO fixture_custom_eraser USING (true);`);
  let reachedHelper = false;
  const outside = mounts(db, actor, operations(db, undefined, undefined, {
    run: work => transaction(db.owner, async lane => {
      await rc(lane);
      await lane.query("SET LOCAL ROLE fixture_custom_eraser");
      return work({ query: (sql, values) => {
        if (sql.includes("AS evidence")) reachedHelper = true;
        return lane.query(sql, values ? [...values] : undefined);
      } });
    }), close: async () => {},
  }));
  refusal(await outside.mounted("public", "export", subject), unavailableCode);
  expect(reachedHelper).toBe(true);
  await transaction(db.owner, async lane => {
    await lane.query("SET LOCAL ROLE fixture_custom_eraser");
    expect((await lane.query("SELECT public.customer_preferences_prepare_erasure() AS prepared")).rows).toEqual([{ prepared: true }]);
    await expect(lane.query("SELECT public.subscriptions__read_renewal_occurrences_for_privacy($1,NULL)", [f.clientId]))
      .rejects.toMatchObject({ code: "42501" });
  }, "ROLLBACK");
  await transaction(db.owner, async lane => {
    await lane.query(`GRANT EXECUTE ON FUNCTION ${occurrenceHelper} TO fixture_custom_eraser; SET LOCAL ROLE fixture_custom_eraser`);
    await expect(lane.query("SELECT public.subscriptions__read_renewal_occurrences_for_privacy($1,NULL)", [f.clientId]))
      .rejects.toMatchObject({ code: "42501" });
  }, "ROLLBACK");

  // The supported login keeps its service_role membership, with export removed in this disposable store.
  await db.owner.query("REVOKE EXECUTE ON FUNCTION public.customer_preferences_export(uuid) FROM service_role");
  expect((await db.runtime.query(`SELECT row_security_active('public.clients') AS rls,
    row_security_active('public.subscription_cycle_occurrences') AS carrier_rls,
    has_function_privilege(current_user,'public.customer_preferences_export(uuid)','EXECUTE') AS exports,
    has_function_privilege(current_user,$1,'EXECUTE') AS helper`, [occurrenceHelper])).rows)
    .toEqual([{ rls: true, carrier_rls: true, exports: false, helper: true }]);
  await receiptRetention(db.owner, await eraseThrough(mounted, "public", empty), []);
  await receiptRetention(db.owner, await eraseThrough(mounted, "public", subject));
  await receiptRetention(db.owner, await eraseThrough(mounted, "public", linked), []);
}), postgresSetupTimeoutMs);

it("isolates direct helper reads from the mounted operation on another subject", () => withPrivacyStore(async db => {
  const actor = await privacyActor(db.owner);
  const b = await rootFixture(db.migrator);
  const unlinked = randomUUID();
  await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'unlinked@example.invalid')", [unlinked]);
  const coordinates = [[b.clientId, null], [null, unlinked]];
  const read = (lane: PgQueryExecutor | Pool, pair: (string | null)[]) =>
    lane.query("SELECT public.subscriptions__read_renewal_occurrences_for_privacy($1,$2) AS evidence", pair).then(r => r.rows[0].evidence);
  const expected = await Promise.all(coordinates.map(pair => read(db.runtime, pair)));
  expect(expected).toEqual([{ occurrences: [expect.objectContaining({ subscriptionId: b.subscriptionId, cycleKey: b.cycleKey })], hasReceipt: false, parentCount: "1" },
    { occurrences: [], hasReceipt: false, parentCount: "0" }]);
  const a = await rootFixture(db.migrator);
  const request = inputFor(a.clientId);
  const observations: unknown[] = [];
  const inspect = async (lane: PgQueryExecutor) => {
    observations.push([await read(lane, coordinates[0]!), await read(lane, coordinates[1]!)]);
  };
  const store = runtime.createPostgresPrivacyStore(), save = store.saveReceipt.bind(store);
  store.saveReceipt = async (...args) => { await save(...args); await inspect(args[0]); };
  const mounted = mounts(db, actor, operations(db, undefined, inspect, unit(db.runtime), store));
  checkProjection(await readExport(mounted, request), a);
  await verifyCancellation(db.owner, a, await cancelOccurrence(db.migrator, a, actor.principalId));
  await receiptRetention(db.owner, await eraseThrough(mounted, "public", request));
  expect(observations).toEqual([expected, expected, expected]);
  const unlinkedReport = await readExport(mounted, { subject: { kind: "principal", principalId: unlinked }, idempotencyKey: randomUUID() });
  expect(unlinkedReport.documents.find(d => d.contributorId === "customer-preferences")?.data).toEqual([]);
}), postgresSetupTimeoutMs);

it("serializes each installed destination path with owner calls and both erasure orders", () => withPrivacyStore(async db => {
  const actor = await privacyActor(db.owner);
  async function fixture() {
    const f = await rootFixture(db.migrator);
    const principalRef = randomUUID();
    await db.owner.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.clientId, principalRef]);
    return { f, ctx: { clientId: f.clientId, scopeRef: f.subscriptionId, owner: {
      installationRef: "fixture-installation", principalKind: "customer", principalRef, customerOrSessionRef: f.clientId,
    } } };
  }
  for (const recheck of [false, true]) {
    const { f, ctx } = await fixture();
    const destination = (lane: Db, input = ctx) => recheck
      ? call(lane, "commerce_recheck_destination_v2", [input, "subscription", input.scopeRef, null, null, null])
      : call(lane, "commerce_read_destination_v2", [input, "subscription", input.scopeRef, null]);
    const reader = await db.runtime.connect(), owner = await db.migrator.connect(), guard = await db.owner.connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await owner.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await guard.query("BEGIN");
      await guard.query("SELECT id FROM public.clients WHERE id=$1 FOR UPDATE", [f.clientId]);
      const readerPid = await pidOf(reader), ownerPid = await pidOf(owner), guardPid = await pidOf(guard);
      const reading = destination(reader).catch((error: unknown) => error);
      await waitForBlock(db.owner, readerPid, guardPid);
      const writing = selectRoot(owner, f).catch((error: unknown) => error);
      await expect.poll(async () => (await db.owner.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [ownerPid])).rows[0].blocked).toBe(true);
      await guard.query("COMMIT");
      expect(await reading).toMatchObject({ code: "destination_v2_selection_required" });
      await waitForBlock(db.owner, ownerPid, readerPid);
      await reader.query("COMMIT");
      expect(await writing).toMatchObject({ outcome: "created" });
      await owner.query("COMMIT");
    } finally {
      for (const lane of [guard, reader, owner]) { await lane.query("ROLLBACK"); lane.release(); }
    }

    await verifyCancellation(db.owner, f, await cancelOccurrence(db.migrator, f, actor.principalId));
    const declared = barrier();
    let waiter = 0, pending!: Promise<Wire>;
    const waitingErase = mounts(db, actor, operations(db, undefined, async executor => {
      waiter = await pidOf(executor); declared.resolve();
    }));
    try {
      await transaction(db.runtime, async lane => {
        await rc(lane);
        expect(await destination(lane)).toMatchObject({ code: "destination_v2_selection_required" });
        pending = waitingErase.mounted("public", "erase", inputFor(f.clientId));
        await holdReached(declared, pending);
        await waitForBlock(db.owner, waiter, await pidOf(lane));
      });
    } finally { await pending; }
    expect((await pending).status).toBe(200);
    await receiptRetention(db.owner, (await pending).body.data!);

    const next = await fixture();
    await persistRoot(db.migrator, next.f);
    await verifyCancellation(db.owner, next.f, await cancelOccurrence(db.migrator, next.f, actor.principalId));
    const reached = barrier(), release = barrier(), store = runtime.createPostgresPrivacyStore();
    const save = store.saveReceipt.bind(store);
    let eraser = 0;
    store.saveReceipt = async (...parameters) => {
      eraser = await pidOf(parameters[0]); reached.resolve(); await release.promise;
      return save(...parameters);
    };
    const mounted = mounts(db, actor, operations(db, undefined, undefined, unit(db.runtime), store));
    const request = mounted.mounted("public", "erase", inputFor(next.f.clientId));
    try {
      await holdReached(reached, request);
      await transaction(db.runtime, async lane => {
        await rc(lane);
        const waiting = await pidOf(lane);
        const reading = destination(lane, next.ctx).catch((error: unknown) => error);
        try { await waitForBlock(db.owner, waiting, eraser); }
        finally { release.resolve(); }
        expect(await reading).toMatchObject({ code: "destination_evidence_unavailable" });
      });
    } finally { release.resolve(); await request; }
    await receiptRetention(db.owner, (await request).body.data!);
  }
}), postgresSetupTimeoutMs);
