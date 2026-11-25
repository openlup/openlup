import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSchemaProbe } from "@openlup/core/readiness";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import type { PgQueryExecutor } from "@openlup/platform/data";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import * as identity from "@openlup/platform/identity";
import type { ErasureReceipt, PrivacyEraseRequest } from "@openlup/platform/identity/contracts";
import { PostgresTransferError } from "@openlup/platform/portability";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { nativePrivacyContributors } from "../../server/runtime/auth/privacyBinding.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { buildIdentityReferenceRuntime } from "../identity/acceptance.conformance.js";
import { createAccountMutationsTemplate, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
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
  & Pick<typeof identity, "createPrivacyOperations" | "createPrivacyExportHandler" | "createPrivacyEraseHandler" | "PrivacyRefusal">;
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
    'export { createPrivacyOperations, createPrivacyExportHandler, createPrivacyEraseHandler, PrivacyRefusal } from "@openlup/platform/identity";',
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

function operations(db: AccountMutationsStore, fault?: "owner" | "reader", afterDeclaration?: () => Promise<void>) {
  const store = identity.createPostgresPrivacyStore();
  const owners = nativePrivacyContributors(store);
  const read = store.readRequiredContributorIds.bind(store);
  if (fault === "reader" || afterDeclaration) store.readRequiredContributorIds = async executor => {
    if (fault === "reader") await executor.query("SELECT public.fixture_unavailable_reader()");
    const required = await read(executor);
    await afterDeclaration?.();
    return required;
  };
  const registry = identity.createPersonalDataContributorRegistry(
    owners.filter(owner => fault !== "owner" || owner.id !== missingOwner), { requiredContributorIds: [] },
  );
  return runtime.createPrivacyOperations<PgQueryExecutor>({ store, registry, unitOfWork: unit(db.runtime), now: () => new Date(), randomId: randomUUID });
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
