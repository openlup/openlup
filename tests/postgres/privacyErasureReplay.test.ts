import { randomUUID } from "node:crypto";
import { disposition as orderDraftReceiptDisposition } from "./orderDraftReceiptsV2.fixture.js";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import * as identity from "@openlup/platform/identity";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { nativePrivacyContributors } from "../../server/runtime/auth/privacyBinding.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { createAccountMutationsTemplate, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";

const table = "public.identity_privacy_erasure_reconciliations";
const reader = "public.identity_privacy_reconciled_contributor_ids(uuid)";
const receipts = "public.identity_privacy_erasures";
const suffix = "_identity_privacy_erasure_reconciliations.sql";
const addresses = "customer-saved-addresses", preferences = "customer-preferences";
const coverageCode = "PRIVACY_RECEIPT_COVERAGE_INCOMPLETE";
const approvalCode = "PRIVACY_RECONCILIATION_APPROVAL_UNVERIFIED";
const profiles = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;
const predecessor = "db/platform/migrations/20261127030000_subscription_destination_v2.sql";
// These inventory pins are stable because the predecessor has already landed.
const predecessorInventory = {
  legacy: "8e1e71413a13096ff346a372e108a341888559710658381d2646aa31f0fe86a2",
  bootstrap: "3a975d84d61ba04d2fd030e417b40a03e10038c8512f85038f1c3da154d3168c",
  separate: "4cb2b2bf42d8afed96f274fb04b60f5644d152a7ba518248364fb17fd248ca24",
  "admin-managed": "662c5240cafb83a19280d8bbb7e67a851f9c0eb1b825e42996390e07d2423419",
  "admin-operator": "3daed53a69520f2e98c057ce0878a607c269c84b77a0d9c9671f88e03437bb83",
};
function forwardPlan() {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Expected the qualified platform manifest");
  const forward = manifest.forward.find(unit => unit.file.endsWith(suffix));
  expect(forward, "the ledger's own native forward").toBeDefined();
  return { manifest, forward: forward!.file };
}

function writePrefix(root: string, manifest: ReturnType<typeof forwardPlan>["manifest"]) {
  manifest.objectInventorySha256 = predecessorInventory.legacy;
  manifest.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: predecessorInventory.bootstrap }, separateMigrator: { withRestore: predecessorInventory.separate } };
  manifest.qualifiedAdmin.objectInventorySha256 = { installerManaged: predecessorInventory["admin-managed"], operatorProvisioned: predecessorInventory["admin-operator"] };
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    const index = plan.forward.findIndex(unit => unit.file === predecessor);
    expect(index, `landed predecessor ${predecessor}`).toBeGreaterThanOrEqual(0);
    plan.forward = plan.forward.slice(0, index + 1);
    for (const unit of [plan.baseline, ...plan.forward]) {
      const target = join(root, unit.file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(unit.file, target);
    }
  }
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
}

const unitOfWork = (pool: Pool) => identity.createPostgresPrivacyUnitOfWork({ connectionString: "postgresql://unused.invalid/fixture" }, { poolFactory: () => pool });
const ledger = (db: Pool) => db.query("SELECT * FROM public.platform_schema_migrations ORDER BY position").then(result => result.rows);

async function seed(db: AccountMutationsStore) {
  const actor = { principalId: randomUUID() }, principalId = randomUUID(), contactId = randomUUID();
  const erasureId = randomUUID(), idempotencyKey = randomUUID();
  const store = identity.createPostgresPrivacyStore();
  const owners = nativePrivacyContributors(store);
  const selected = owners.find(owner => owner.id === addresses)!;
  const eraseAddress = selected.eraseOrRetain;
  const effect = vi.spyOn(selected, "eraseOrRetain");
  const prepare = vi.spyOn(selected, "prepareErasure");
  const assess = vi.spyOn(selected, "assessErasure");
  const other = vi.spyOn(owners.find(owner => owner.id === preferences)!, "eraseOrRetain");
  const registry = identity.createPersonalDataContributorRegistry(owners, { requiredContributorIds: [] });
  const operations = identity.createPrivacyOperations({ store, unitOfWork: unitOfWork(db.runtime), registry, now: () => new Date(), randomId: randomUUID });
  const required = await identity.readRequiredPrivacyContributorIds(db.runtime);
  const full = Object.fromEntries(owners.filter(owner => required.includes(owner.id)).map(owner => [owner.id, owner.version]));
  expect(Object.keys(full).sort()).toEqual(required);
  const { [addresses]: _omitted, ...historical } = full;
  await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'admin@example.invalid'),($2,'historical@example.invalid')", [actor.principalId, principalId]);
  await db.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',now())", [actor.principalId]);
  await db.owner.query("INSERT INTO public.clients(id,email) VALUES ($1,'erased@example.invalid')", [contactId]);
  await db.owner.query("INSERT INTO public.customer_saved_addresses(client_id,kind,line1,city,postal_code) VALUES ($1,'shipping','Fixture Street','Fixture Town','00000')", [contactId]);
  await db.owner.query("INSERT INTO public.customer_payment_preferences(client_id,scope,method_kind) VALUES ($1,'any','card')", [contactId]);
  await db.owner.query(`INSERT INTO ${receipts}
    (erasure_id,idempotency_key,client_id,principal_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
    VALUES ($1,$2,$3,$4,$5,'identity.erasure.v1',$6,$7,'[]',now())`,
  [erasureId, idempotencyKey, contactId, principalId, actor.principalId, historical,
    JSON.stringify(required.includes(orderDraftReceiptDisposition.contributorId) ? [orderDraftReceiptDisposition] : [])]);
  const input = { subject: { kind: "contact" as const, contactId }, idempotencyKey };
  const alias = { subject: { kind: "principal" as const, principalId }, idempotencyKey: randomUUID() };
  const approval = { erasure_id: erasureId, contributor_id: addresses, evidence_ref: randomUUID() };
  const count = () => db.owner.query("SELECT count(*)::int AS rows FROM public.customer_saved_addresses WHERE client_id=$1", [contactId]).then(result => result.rows[0].rows);
  const original = () => db.owner.query(`SELECT to_jsonb(e)::text AS bytes FROM ${receipts} e WHERE erasure_id=$1`, [erasureId]).then(result => result.rows[0].bytes);
  const versions = (value: unknown) => db.owner.query(`UPDATE ${receipts} SET contributor_versions=$2::jsonb WHERE erasure_id=$1`, [erasureId, JSON.stringify(value)]);
  const preferenceCount = () => db.owner.query("SELECT count(*)::int AS rows FROM public.customer_payment_preferences WHERE client_id=$1", [contactId]).then(result => result.rows[0].rows);
  return { actor, registry, operations, input, alias, approval, count, preferenceCount, original, versions, full, historical, eraseAddress, effect, prepare, assess, other };
}

it.each(profiles)("installs, upgrades and reconciles in %s", async profile => {
  const { manifest, forward } = forwardPlan();
  const prefix = mkdtempSync(join(tmpdir(), "privacy-reconciliation-prefix-"));
  let previous: Awaited<ReturnType<typeof createAccountMutationsTemplate>> | undefined;
  let current: typeof previous;
  try {
    writePrefix(prefix, structuredClone(manifest));
    const plan = profile === "legacy" ? manifest : profile.startsWith("admin-") ? manifest.qualifiedAdmin : manifest.qualified;
    const later = plan.forward.slice(plan.forward.findIndex(unit => unit.file === predecessor) + 1).map(unit => unit.file);
    expect(later).toContain(forward);
    previous = await createAccountMutationsTemplate(profile, "privacy-prefix", prefix);
    const db = await previous.clone();
    const f = await seed(db);
    const oldLedger = await ledger(db.owner), oldReceipt = await f.original();
    expect((await db.owner.query("SELECT to_regprocedure($1) AS reader", [reader])).rows[0].reader).toBeNull();
    await expect(f.operations.erase(f.actor, f.input)).rejects.toMatchObject({ code: "PRIVACY_ASSESSMENT_UNAVAILABLE" });
    expect((await db.runner.apply()).applied).toEqual(later);
    expect((await ledger(db.owner)).slice(0, oldLedger.length)).toEqual(oldLedger);
    expect((await db.runner.apply()).applied).toEqual([]);
    expect(await f.original()).toBe(oldReceipt);
    current = await createAccountMutationsTemplate(profile, "privacy-fresh");
    const fresh = await current.clone();
    expect((await fresh.runtime.query("SELECT to_regprocedure($1) AS reader", [reader])).rows[0].reader).not.toBeNull();
    expect((await fresh.runner.apply()).applied).toEqual([]);

    f.prepare.mockClear();
    for (const input of [f.input, f.alias]) {
      await expect(f.operations.erase(f.actor, input)).rejects.toMatchObject({ code: coverageCode, facts: { observed: expect.stringContaining(addresses) } });
    }
    expect(f.effect).not.toHaveBeenCalled();
    expect(await f.count()).toBe(1);
    const { reconcilePostgresPrivacyErasure } = identity;
    const context = { unitOfWork: unitOfWork(db.migrator), registry: f.registry, actor: f.actor };
    expect((await db.migrator.query("SELECT current_user")).rows[0].current_user)
      .toBe(db.installation.generation === "legacy" ? "postgres" : db.installation.migrationLogin);

    f.prepare.mockClear();
    if (profile !== "legacy") {
      const refused = await reconcilePostgresPrivacyErasure({ ...context, unitOfWork: unitOfWork(db.runtime) }, f.approval).catch(error => error);
      expect(refused).toBeInstanceOf(identity.PrivacyRefusal);
      expect(refused).toMatchObject({ code: "PRIVACY_ASSESSMENT_UNAVAILABLE" });
      expect(Object.getOwnPropertyDescriptor(refused, "cause")).toMatchObject({ enumerable: false, value: expect.any(Error) });
      await expect(db.runtime.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
      await expect(db.runtime.query(`INSERT INTO ${table} (erasure_id,contributor_id,evidence_ref) VALUES ($1,$2,$3)`,
        [f.approval.erasure_id, f.approval.contributor_id, f.approval.evidence_ref])).rejects.toMatchObject({ code: "42501" });
      expect(f.prepare).not.toHaveBeenCalled();
    }

    const sealed = () => db.migrator.query("SELECT pg_has_role(current_user, 'platform_acquisition_owner', 'USAGE') AS open").then(result => result.rows[0].open);
    if (profile === "admin-operator") expect(await sealed()).toBe(false);
    await expect(reconcilePostgresPrivacyErasure(context, f.approval)).resolves.toMatchObject({ contributorId: addresses });
    await expect(reconcilePostgresPrivacyErasure(context, f.approval)).resolves.toBeNull();
    if (profile === "admin-operator") expect(await sealed()).toBe(false);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.assess).toHaveBeenCalledTimes(1);
    expect(f.effect).toHaveBeenCalledTimes(1);
    expect(f.other).not.toHaveBeenCalled();
    expect(await f.count()).toBe(0);
    expect(await f.preferenceCount()).toBe(1);
    expect(await f.original()).toBe(oldReceipt);
    await expect(reconcilePostgresPrivacyErasure(context, { ...f.approval,
      contributor_id: orderDraftReceiptDisposition.contributorId, evidence_ref: randomUUID() })).resolves.toEqual(orderDraftReceiptDisposition);
    for (const input of [f.input, f.alias]) await expect(f.operations.erase(f.actor, input))
      .resolves.toMatchObject({ outcome: "ALREADY_ERASED", erasureId: f.approval.erasure_id, obligations: [] });
  } finally {
    await Promise.all([current?.close(), previous?.close()]);
    rmSync(prefix, { recursive: true, force: true });
  }
}, postgresSetupTimeoutMs);

it("keeps coverage, bindings, privileges and rollback scoped to the original receipt", async () => {
  const template = await createAccountMutationsTemplate("separate", "privacy-approval");
  try {
    const db = await template.clone(), f = await seed(db);
    const { reconcilePostgresPrivacyErasure: reconcile } = identity;
    const owner = { unitOfWork: unitOfWork(db.migrator), registry: f.registry, actor: f.actor };
    const replay = () => f.operations.erase(f.actor, f.input);
    const approvals = () => db.owner.query(`SELECT * FROM ${table} ORDER BY contributor_id`).then(result => result.rows);
    await expect(replay()).rejects.toMatchObject({ code: coverageCode, facts: { observed: `A prior erasure is missing recorded coverage for the required owners (${addresses}).` } });
    await expect(f.operations.erase(f.actor, { ...f.input, subject: { kind: "contact", contactId: randomUUID() } }))
      .rejects.toMatchObject({ code: "PRIVACY_IDEMPOTENCY_CONFLICT" });
    await f.versions(Object.fromEntries(Object.keys(f.full).map(id => [id, id === orderDraftReceiptDisposition.contributorId ? orderDraftReceiptDisposition.version : "historical.v2"])));
    await expect(replay()).resolves.toMatchObject({ outcome: "ALREADY_ERASED" });
    for (const value of [null, [], { ...f.full, identity: { version: "identity.v1" } }, { ...f.full, identity: 1 },
      Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`fixture-${index}`, "fixture.v1"]))]) {
      await f.versions(value);
      await expect(replay()).rejects.toMatchObject({ code: coverageCode, facts: { observed: expect.stringContaining(Object.keys(f.full).sort().join(", ")) } });
    }
    await f.versions(f.historical);

    for (const [grant, revoke] of [
      [`GRANT SELECT (contributor_id) ON ${table} TO authenticated`, `REVOKE SELECT (contributor_id) ON ${table} FROM authenticated`],
      [`GRANT SELECT ON ${table} TO PUBLIC`, `REVOKE SELECT ON ${table} FROM PUBLIC`],
      [`GRANT SELECT ON ${receipts} TO PUBLIC`, `REVOKE SELECT ON ${receipts} FROM PUBLIC`],
    ]) {
      await db.migrator.query(grant);
      f.prepare.mockClear();
      try {
        await expect(replay()).rejects.toMatchObject({ code: "PRIVACY_STORE_PRIVILEGES_UNSAFE" });
        expect(f.prepare).not.toHaveBeenCalled();
      } finally { await db.migrator.query(revoke); }
      await expect(replay()).rejects.toMatchObject({ code: coverageCode });
    }

    await db.migrator.query(`REVOKE EXECUTE ON FUNCTION ${reader} FROM service_role`);
    try { await expect(replay()).rejects.toMatchObject({ code: "PRIVACY_ASSESSMENT_UNAVAILABLE" }); }
    finally { await db.migrator.query(`GRANT EXECUTE ON FUNCTION ${reader} TO service_role`); }
    for (const input of [{ ...f.approval, erasure_id: randomUUID() }, { ...f.approval, contributor_id: "foreign-owner" },
      { ...f.approval, extra: true }, [], ...Object.keys(f.approval).map(key => ({ ...f.approval, [key]: { value: "synthetic" } }))]) {
      const refused = await reconcile(owner, input as typeof f.approval).catch(error => error);
      expect(Object.getPrototypeOf(refused)).toBe(identity.PrivacyRefusal.prototype);
      expect(Reflect.ownKeys(refused).filter(key => key !== "stack").sort()).toEqual(["code", "facts", "message", "name"]);
      expect(refused).toMatchObject({ code: approvalCode, facts: {
        observed: "The approval reference could not be bound to this erasure and owner.",
        cause: expect.any(String), fix: expect.any(String), recheck: expect.any(String),
      } });
    }
    expect(f.effect).not.toHaveBeenCalled();
    expect(await approvals()).toEqual([]);

    f.effect.mockImplementationOnce(async (...args) => { await f.eraseAddress(...args); throw new Error("deliberate disposition failure"); });
    await expect(reconcile(owner, f.approval)).rejects.toThrow();
    expect(await f.count()).toBe(1);
    expect(await approvals()).toEqual([]);

    const { [preferences]: _omitted, ...missingBoth } = f.historical;
    await f.versions(missingBoth);
    const oldReceipt = await f.original();
    let entered!: () => void, release!: () => void;
    const effectReached = new Promise<void>(resolve => { entered = resolve; });
    const continueEffect = new Promise<void>(resolve => { release = resolve; });
    f.effect.mockImplementationOnce(async (...args) => {
      const disposition = await f.eraseAddress(...args);
      entered();
      await continueEffect;
      return disposition;
    });
    const ownerCall = reconcile(owner, f.approval);
    const concurrentReplay = Promise.race([effectReached, ownerCall.then(() => { throw new Error("missing contributor barrier"); })])
      .then(() => replay().then(result => result, (error: unknown) => error));
    try {
      await Promise.race([effectReached, ownerCall]);
      await vi.waitFor(async () => {
        const { rows } = await db.owner.query(`SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE database = (SELECT oid FROM pg_database WHERE datname=current_database())
          AND relation = '${receipts}'::regclass AND mode = 'ShareRowExclusiveLock' AND NOT granted
        ) AS waiting`);
        expect(rows[0].waiting).toBe(true);
      }, { timeout: 2_000, interval: 20 });
      expect(await f.count()).toBe(1);
      expect(await approvals()).toEqual([]);
    } finally {
      release();
      await Promise.allSettled([ownerCall, concurrentReplay]);
    }
    await expect(ownerCall).resolves.toMatchObject({ contributorId: addresses });
    expect(await concurrentReplay).toMatchObject({ code: coverageCode, facts: { observed: expect.stringContaining(preferences) } });
    await expect(reconcile(owner, { ...f.approval, evidence_ref: randomUUID() })).rejects.toMatchObject({ code: approvalCode });
    await expect(reconcile(owner, { ...f.approval, contributor_id: preferences })).rejects.toMatchObject({ code: approvalCode });
    expect(await approvals()).toEqual([f.approval]);
    expect(await f.preferenceCount()).toBe(1);
    await expect(reconcile(owner, { ...f.approval, contributor_id: preferences, evidence_ref: randomUUID() }))
      .resolves.toMatchObject({ contributorId: preferences });
    expect(await f.preferenceCount()).toBe(0);
    expect(await f.original()).toBe(oldReceipt);
    await expect(replay()).resolves.toMatchObject({ outcome: "ALREADY_ERASED" });
    await f.versions({ identity: 1 });
    await expect(replay()).rejects.toMatchObject({ code: coverageCode, facts: { observed: expect.stringContaining("identity") } });
    const remaining = Object.keys(f.full).filter(id => id !== addresses && id !== preferences);
    await db.owner.query(`INSERT INTO ${table}(erasure_id,contributor_id,evidence_ref)
      SELECT $1, contributor_id, evidence_ref FROM unnest($2::text[], $3::uuid[]) AS approval(contributor_id,evidence_ref)`,
    [f.approval.erasure_id, remaining, remaining.map(() => randomUUID())]);
    await expect(replay()).resolves.toMatchObject({ outcome: "ALREADY_ERASED" });
  } finally { await template.close(); }
}, postgresSetupTimeoutMs);

it.each([false, true])("checks native ledger pgTAP with managed-compatible defaults (service role %s)", async withServiceRole => {
  const { forward, manifest } = forwardPlan();
  const container = await runManagedCompatPostgres({ name: `privacy-reconciliation-tap-${withServiceRole}-${process.pid}`, password: "synthetic-conformance" });
  const owner = new Pool({ connectionString: container.connectionString });
  const bootstrap = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  try {
    if (!withServiceRole) await bootstrap.query("DROP OWNED BY service_role CASCADE; DROP ROLE service_role");
    await owner.query("CREATE TABLE public.identity_privacy_erasures(erasure_id uuid PRIMARY KEY)");
    const declaration = manifest.forward.find(unit => unit.file.endsWith("_identity_privacy_required_contributors.sql"))!;
    for (const file of [declaration.file, forward]) await owner.query(readFileSync(file, "utf8"));
    await bootstrap.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions");
    const output = await owner.query(readFileSync("tests/postgres/fixtures/privacyErasureReconciliations.sql", "utf8"));
    const lines = (Array.isArray(output) ? output : [output]).flatMap(result => result.rows.flatMap(row => Object.values(row).map(String)));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(10);
  } finally { await closePostgres(container, [owner, bootstrap]); }
}, postgresSetupTimeoutMs);
