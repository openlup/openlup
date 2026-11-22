import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import { canonicalCatalogDraftJson, catalogDefinitionDigest, catalogPackManifest, installCatalogDefinitions,
  readInstalledCatalogSubscriptionProfile, withCatalogPublicationRules } from "@openlup/platform/catalog";
import type { CatalogPackInput } from "@openlup/platform/catalog/contracts";
import { selectCatalogProfileCadence } from "@openlup/platform/subscriptions";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const forward = "db/platform/migrations/20261124230000_subscription_profiles.sql";
const receiptTable = "public.catalog_subscription_profile_receipts";
const digest = (bytes: string) => createHash("sha256").update(bytes, "utf8").digest("hex");
const ref = { key: "example:repeat", version: 1 };
const fixed = (days: number) => ({ schemaVersion: 1, kind: "fixed_days", days } as const);
const declaration = (profile = ref, days = 28): CatalogSubscriptionProfileV1 => ({
  ...profile, allowedCadences: [fixed(days)],
  policyRef: { key: "example:repeat-policy", version: 2 }, policyDigest: digest("synthetic policy"),
});
const legacyPack = withCatalogPublicationRules<CatalogPackInput>({
  id: "example:legacy", namespace: "example", version: 1, openlupRange: "1.x", capabilities: {},
  types: [{
    key: "example:item", version: 1, units: [{ code: "openlup:piece", dimension: "count", integral: true }],
    netContentUnits: ["openlup:piece"], dimensions: [], subscriptionProfileRef: ref, validateContent: () => [],
  }],
  taxClasses: [], subscriptionProfiles: [ref, ref],
}, () => readFileSync("examples/neutral-store/owned/catalogue-rules.cjs"));

const pools: Pool[] = [];
let container: PostgresContainer, owner: Pool, runtime: Pool;
let legacyReceipt: Awaited<ReturnType<typeof installCatalogDefinitions>>;
let savedLegacyRow: string;
const upgradeRef = { key: "example:upgrade-profile", version: 1 };
const upgradePack = profilePack("upgrade", upgradeRef, "example:upgrade-item");
let upgradeReceipt: typeof legacyReceipt;
let savedUpgradeRow: string;

function profilePack(name: string, profileRef: typeof ref, typeKey: string): CatalogPackInput {
  return withCatalogPublicationRules({
    ...legacyPack, id: `example:${name}`, subscriptionProfiles: [profileRef],
    types: [{ ...legacyPack.types[0], key: typeKey, subscriptionProfileRef: profileRef }],
  }, () => readFileSync("examples/neutral-store/owned/catalogue-rules.cjs"));
}
function nextPack(first: CatalogPackInput, profileRef: typeof ref): CatalogPackInput {
  return withCatalogPublicationRules({
    ...first, version: 2, subscriptionProfiles: [...first.subscriptionProfiles!, profileRef],
    types: [first.types[0], { ...first.types[0], version: 2, subscriptionProfileRef: profileRef }],
    taxClasses: [{ key: `${first.id}-next` }],
  }, () => readFileSync("examples/neutral-store/owned/catalogue-rules.cjs"));
}
async function packRow(id: string, version = 1): Promise<string> {
  const { rows } = await owner.query<{ value: string }>(
    "SELECT to_jsonb(i)::text AS value FROM public.catalog_definition_installs i WHERE pack_id=$1 AND pack_version=$2", [id, version]);
  return rows[0]!.value;
}

// Canonical fixture bytes model the SQL caller independently of the Core declaration API.
function request(id: string, refs: readonly typeof ref[], profiles: readonly ReturnType<typeof declaration>[]) {
  const profileDeclarationBytes = profiles.map(profile => canonicalCatalogDraftJson(profile));
  const subscriptionProfileDefinitions = profiles.map((profile, index) => ({
    ...profile, profileDigest: digest(profileDeclarationBytes[index]!),
  }));
  const manifest = canonicalCatalogDraftJson({
    id, version: 1, namespace: "example", openlupRange: "1.x", capabilities: {},
    types: [], taxClasses: [], subscriptionProfiles: refs, subscriptionProfileDefinitions,
  });
  return { id, manifest, subscriptionProfileDefinitions, payload: { manifest, types: [], taxClasses: [], profileDeclarationBytes } };
}
async function install(db: Pool | PoolClient, input: ReturnType<typeof request>) {
  const { rows } = await db.query("SELECT public.catalog_definition_install($1,1,$2::jsonb) AS receipt", [input.id, input.payload]);
  return rows[0].receipt;
}

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-profiles-${process.pid}`, password: "synthetic-profiles" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue profile PostgreSQL unavailable");
  const pool = (connectionString: string) => { const db = new Pool({ connectionString }); pools.push(db); return db; };
  const bootstrap = pool(container.connectionString);
  await bootstrap.query(`CREATE ROLE profile_owner LOGIN SUPERUSER PASSWORD 'synthetic-profiles';
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE profile_runtime LOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS PASSWORD 'synthetic-profiles';
    ALTER DATABASE postgres OWNER TO profile_owner;
    GRANT service_role TO profile_runtime WITH INHERIT TRUE, SET TRUE`);
  const login = new URL(container.connectionString);
  login.username = "profile_owner";
  owner = pool(login.toString());
  login.username = "profile_runtime";
  runtime = pool(login.toString());
  const { baseline, forward: migrations } = selectPlatformMigrationManifest(
    readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest, "legacy");
  expect(migrations.some(unit => unit.file === forward)).toBe(true);
  for (const { file } of [baseline, ...migrations]) {
    if (file === forward) break;
    await owner.query(readFileSync(file, "utf8"));
  }
  legacyReceipt = await installCatalogDefinitions(owner, legacyPack);
  savedLegacyRow = await packRow(legacyPack.id);
  upgradeReceipt = await installCatalogDefinitions(owner, upgradePack);
  savedUpgradeRow = await packRow(upgradePack.id);
  await bootstrap.query("ALTER ROLE profile_owner NOSUPERUSER NOBYPASSRLS");
  await owner.query(readFileSync(forward, "utf8"));
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pools), postgresTeardownTimeoutMs);

it("C-2 preserves a pre-forward reference-only replay with duplicate refs and an installed type", async () => {
  expect(catalogPackManifest(legacyPack).subscriptionProfiles).toEqual([ref, ref]);
  const replay = await installCatalogDefinitions(owner, legacyPack);
  expect(replay).toEqual(legacyReceipt);
  expect(replay.installedAt).toBe(legacyReceipt.installedAt);
  expect(await packRow(legacyPack.id)).toBe(savedLegacyRow);
  expect((await owner.query("SELECT definition->'subscriptionProfileRef' AS ref FROM public.catalog_type_versions WHERE type_key='example:item'")).rows)
    .toEqual([{ ref }]);
  await expect(owner.query(`UPDATE public.catalog_definition_installs
    SET receipt=receipt || '{"subscriptionProfileDefinitions":[]}'::jsonb WHERE pack_id=$1`, [legacyPack.id]))
    .rejects.toMatchObject({ code: "55000", message: "catalog_definition_install_profile_immutable" });
});

it("AK-1 binds canonical bytes and identity at owner INSERT, freezes receipts and denies runtime access", async () => {
  const key = { key: "example:direct", version: 1 };
  const profile = declaration(key);
  const bytes = canonicalCatalogDraftJson(profile);
  const storedDigest = digest(bytes);
  const values = [key.key, key.version, storedDigest, Buffer.from(bytes, "utf8"), legacyPack.id];
  const sql = `INSERT INTO ${receiptTable}(profile_key,profile_version,profile_digest,declaration_bytes,pack_id,pack_version)
    VALUES ($1,$2,$3,$4,$5,1)`;
  const identity = "SELECT public.catalog_subscription_profile_identity($1,$2) AS identity";
  expect((await owner.query(`SELECT c.relowner=current_user::regrole AS owned,c.relrowsecurity,r.rolsuper,r.rolbypassrls
    FROM pg_class c JOIN pg_roles r ON r.rolname=current_user WHERE c.oid=$1::regclass`, [receiptTable])).rows)
    .toEqual([{ owned: true, relrowsecurity: true, rolsuper: false, rolbypassrls: false }]);
  await expect(owner.query(sql, [key.key, key.version, "0".repeat(64), ...values.slice(3)]))
    .rejects.toSatisfy((error: Error) => {
      expect(error).toMatchObject({ code: "23514", message: "catalog_profile_receipt_digest_mismatch" });
      expect(error).not.toHaveProperty("value");
      expect(error).not.toHaveProperty("issue");
      return true;
    });
  await expect(owner.query(sql, ["example:other", key.version, ...values.slice(2)]))
    .rejects.toMatchObject({ code: "23514", message: "catalog_profile_receipt_identity_mismatch" });
  await expect(owner.query(sql, [key.key, 2, ...values.slice(2)]))
    .rejects.toMatchObject({ code: "23514", message: "catalog_profile_receipt_identity_mismatch" });
  await owner.query(sql, values);
  await expect(owner.query(sql, values))
    .rejects.toMatchObject({ code: "23505", constraint: "catalog_subscription_profile_receipts_identity" });
  await expect(owner.query("DELETE FROM public.catalog_definition_installs WHERE pack_id=$1", [legacyPack.id]))
    .rejects.toMatchObject({ code: "23503" });
  for (const action of [`UPDATE ${receiptTable} SET profile_digest=profile_digest`, `DELETE FROM ${receiptTable}`]) {
    await expect(owner.query(`${action} WHERE profile_key=$1`, [key.key]))
      .rejects.toMatchObject({ code: "55000", message: "catalog_definition_install_profile_immutable" });
  }
  expect((await owner.query(`SELECT * FROM ${receiptTable} WHERE profile_key=$1`, [key.key])).rows).toEqual([{
    profile_key: key.key, profile_version: key.version, profile_digest: storedDigest,
    declaration_bytes: Buffer.from(bytes, "utf8"), pack_id: legacyPack.id, pack_version: 1,
  }]);
  expect((await owner.query(identity, [key.key, key.version])).rows).toEqual([{ identity: {
    profileKey: key.key, profileVersion: key.version, profileDigest: storedDigest,
    policyRef: profile.policyRef, policyDigest: profile.policyDigest,
  } }]);
  expect((await owner.query(identity, [key.key, 2])).rows).toEqual([{ identity: null }]);
  await expect(runtime.query(`SELECT * FROM ${receiptTable}`)).rejects.toMatchObject({ code: "42501" });
  await expect(runtime.query(sql, values)).rejects.toMatchObject({ code: "42501" });
  await expect(runtime.query(identity, [key.key, key.version])).rejects.toMatchObject({ code: "42501" });
  await expect(install(runtime, request("example:runtime", [key], []))).rejects.toMatchObject({ code: "42501" });
});

async function typeBindings(pack: CatalogPackInput) {
  const { rows } = await owner.query(`SELECT version, definition_digest AS digest, definition->'subscriptionProfileRef' AS ref
    FROM public.catalog_type_versions WHERE type_key=$1 ORDER BY version`, [pack.types[0].key]);
  return rows;
}

async function profileOwners(profileKey: string) {
  const { rows } = await owner.query(`SELECT profile_version, pack_id, pack_version
    FROM ${receiptTable} WHERE profile_key=$1 ORDER BY profile_version`, [profileKey]);
  return rows;
}

async function installCounts() {
  const { rows } = await owner.query(`SELECT
    (SELECT count(*) FROM public.catalog_definition_installs) AS packs,
    (SELECT count(*) FROM ${receiptTable}) AS profiles,
    (SELECT count(*) FROM public.catalog_type_versions) AS types,
    (SELECT count(*) FROM public.catalog_tax_classes) AS taxes`);
  return rows[0];
}

it.each(["both", "new-only"])("AM-1 installs and replays P@2 with %s declarations", async variant => {
  const p1 = { key: `example:profile-${variant}`, version: 1 }, p2 = { ...p1, version: 2 };
  const v1 = { ...declaration(p1), allowedCadences: [fixed(28), fixed(42)] }, v2 = declaration(p2, 35);
  const first = { ...profilePack(variant, p1, `example:item-${variant}`), subscriptionProfileDefinitions: [v1] };
  const second = nextPack(first, p2);
  const receipt1 = await installCatalogDefinitions(owner, first);
  const priorTypes = await typeBindings(first);
  const priorCounts = await installCounts();
  const changed = await installCatalogDefinitions(owner, {
    ...second, subscriptionProfileDefinitions: [v2, declaration(p1, 29)],
  }).catch((error: unknown) => error);
  expect(changed).toMatchObject({ code: "23505", message: "catalog_profile_install_refuses_redefinition" });
  expect((changed as { issue: unknown }).issue).toStrictEqual({
    code: "catalog_profile_install_refuses_redefinition",
    path: "/subscriptionProfileDefinitions/1",
    fix: "Replay the original declaration bytes, digest and identity together. Issue a new version for an intentional change.",
  });
  expect(changed).not.toHaveProperty("value");
  expect(await installCounts()).toEqual(priorCounts);
  const missing = await installCatalogDefinitions(owner, { ...second, subscriptionProfileDefinitions: [v1] }).catch((error: unknown) => error);
  expect(missing).toMatchObject({ code: "22023", message: "definition_unknown_profile_ref", issue: {
    code: "definition_unknown_profile_ref", path: "/subscriptionProfiles/1", ref: p2,
    fix: `Install or declare ${p2.key}@2.`,
  } });
  expect(missing).not.toHaveProperty("issue.value");
  expect(await installCounts()).toEqual(priorCounts);
  expect(await typeBindings(first)).toEqual(priorTypes);
  expect(await readInstalledCatalogSubscriptionProfile(owner, p2)).toBeNull();

  const reordered = { policyDigest: v1.policyDigest, policyRef: v1.policyRef, ...p1, allowedCadences: [...v1.allowedCadences].reverse() };
  const input = { ...second, subscriptionProfileDefinitions: variant === "both" ? [v2, reordered] : [v2] };
  const manifest = catalogPackManifest(input);
  const receipt2 = await installCatalogDefinitions(owner, input);
  expect(receipt2.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);
  expect(receipt2.manifestDigest).toBe(manifest.digest);
  expect(digest(receipt2.canonicalManifest!)).toBe(manifest.digest);
  expect(receipt2.subscriptionProfileDefinitions).toEqual(manifest.subscriptionProfileDefinitions);
  expect(receipt2.subscriptionProfileDefinitions?.map(({ version }) => version)).toEqual(variant === "both" ? [2, 1] : [2]);
  expect(receipt2).toEqual(JSON.parse(await packRow(second.id, 2)).receipt);
  expect(await typeBindings(second)).toEqual([
    ...priorTypes, { version: 2, digest: catalogDefinitionDigest(input.types[1]), ref: p2 },
  ]);
  expect(priorTypes).toEqual([{ version: 1, digest: receipt1.types[0].definitionDigest, ref: p1 }]);
  expect(await installCatalogDefinitions(owner, input)).toEqual(receipt2);
  expect(await installCatalogDefinitions(owner, first)).toEqual(receipt1);
  const reuse = { ...first, id: `${first.id}-reuse`, subscriptionProfileDefinitions: [reordered] };
  expect((await installCatalogDefinitions(owner, reuse)).subscriptionProfileDefinitions).toEqual(receipt1.subscriptionProfileDefinitions);
  expect(await profileOwners(p1.key)).toEqual([
    { profile_version: 1, pack_id: first.id, pack_version: 1 }, { profile_version: 2, pack_id: second.id, pack_version: 2 },
  ]);
});

it("C-3 installs first declarations after a legacy pack and resolves empty declarations by exact version", async () => {
  const p2 = { ...upgradeRef, version: 2 };
  const second = nextPack(upgradePack, p2);
  expect(await readInstalledCatalogSubscriptionProfile(owner, upgradeRef)).toBeNull();
  const v1 = declaration(upgradeRef), v2 = declaration(p2);
  const installed = await installCatalogDefinitions(owner, { ...second, subscriptionProfileDefinitions: [v1, v2] });
  expect(await profileOwners(upgradeRef.key)).toEqual([1, 2].map(profile_version =>
    ({ profile_version, pack_id: second.id, pack_version: 2 })));
  expect(await typeBindings(second)).toEqual([
    { version: 1, digest: upgradeReceipt.types[0].definitionDigest, ref: upgradeRef },
    { version: 2, digest: installed.types[1].definitionDigest, ref: p2 },
  ]);
  expect(await installCatalogDefinitions(owner, upgradePack)).toEqual(upgradeReceipt);
  expect(await packRow(upgradePack.id)).toBe(savedUpgradeRow);
  expect(await readInstalledCatalogSubscriptionProfile(owner, p2)).toEqual({
    profileKey: p2.key, profileVersion: p2.version, profileDigest: installed.subscriptionProfileDefinitions![1].profileDigest,
    policyRef: v2.policyRef, policyDigest: v2.policyDigest,
  });
  const reuse = { ...second, version: 3, subscriptionProfileDefinitions: [] };
  const replayable = await installCatalogDefinitions(owner, reuse);
  expect(replayable.subscriptionProfileDefinitions).toEqual([]);
  expect(await installCatalogDefinitions(owner, reuse)).toEqual(replayable);
  const p3 = { ...p2, version: 3 };
  const counts = await installCounts();
  await expect(installCatalogDefinitions(owner, { ...reuse, version: 4, subscriptionProfiles: [upgradeRef, p2, p3] }))
    .rejects.toMatchObject({ code: "22023", issue: { code: "definition_unknown_profile_ref", path: "/subscriptionProfiles/2", ref: p3 } });
  expect(await installCounts()).toEqual(counts);
});

it("keeps a narrower native quote guard authoritative after the selector admits a choice", async () => {
  const profile = declaration({ key: "example:guard", version: 1 }, 91);
  const choice = fixed(91), choices = [choice], profileRef = { key: profile.key, version: profile.version };
  const pack = { ...legacyPack, id: "example:guard", types: [], subscriptionProfiles: [profileRef], subscriptionProfileDefinitions: [profile] };
  await installCatalogDefinitions(owner, pack);
  const installed = await readInstalledCatalogSubscriptionProfile(owner, profileRef);
  expect(installed).not.toBeNull();
  const selection = selectCatalogProfileCadence({
    choice, mode: "recurring", storeChoices: choices, skuChoices: choices, offerChoices: choices, commandChoices: choices,
    profileRef, profile: { declaration: profile, installed: installed! },
  });
  expect(selection).toEqual({ cadenceDays: 91 });
  if (!("cadenceDays" in selection)) throw new Error("Expected an admitted cadence");
  const db = await owner.connect();
  try {
    await db.query(`BEGIN;
      ALTER TABLE public.subscription_edit_quotes DROP CONSTRAINT subscription_edit_quotes_cadence_check;
      ALTER TABLE public.subscription_edit_quotes ADD CONSTRAINT subscription_edit_quotes_cadence_check
        CHECK (proposed_cadence_days BETWEEN 1 AND 90)`);
    await expect(db.query(`INSERT INTO public.subscription_edit_quotes
      (subscription_id,idempotency_key,request_fingerprint,quote_hash,expected_template_version,proposed_lines,
       proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
       VALUES (gen_random_uuid(),'native-guard',repeat('a',64),repeat('b',64),1,'[]',$1,1,1,'USD',now())`, [selection.cadenceDays]))
      .rejects.toMatchObject({ code: "23514", constraint: "subscription_edit_quotes_cadence_check" });
  } finally {
    try { await db.query("ROLLBACK"); }
    finally { db.release(); }
  }
});

it("C-4 serializes equal-byte and different-byte installs under the same lock", async () => {
  const winner = request("example:first", [ref], [declaration()]);
  const equal = request("example:equal", [ref], [declaration()]);
  const different = request("example:different", [ref], [declaration(ref, 29)]);
  const first = await owner.connect(), equalClient = await owner.connect(), differentClient = await owner.connect();
  let waiters: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const pids = await Promise.all([equalClient, differentClient].map(async db =>
      (await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
    await first.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const receipt = await install(first, winner);
    waiters = Promise.allSettled([install(equalClient, equal), install(differentClient, different)]);
    await expect.poll(async () => (await first.query(`SELECT count(*)::int AS count FROM pg_locks
      WHERE locktype='advisory' AND NOT granted AND pid=ANY($1::integer[])`, [pids])).rows[0].count).toBe(2);
    await first.query("COMMIT");
    const [reused, refused] = await waiters;
    expect(reused).toMatchObject({ status: "fulfilled", value: {
      packId: equal.id, manifestDigest: digest(equal.manifest), canonicalManifest: equal.manifest,
      subscriptionProfileDefinitions: equal.subscriptionProfileDefinitions,
    } });
    expect(reused).toEqual({ status: "fulfilled", value: JSON.parse(await packRow(equal.id)).receipt });
    expect(refused).toMatchObject({ status: "rejected", reason: {
      code: "23505", message: "catalog_profile_install_refuses_redefinition",
    } });
    expect((await owner.query(`SELECT pack_id,pack_version FROM ${receiptTable} WHERE profile_key=$1`, [ref.key])).rows)
      .toEqual([{ pack_id: winner.id, pack_version: 1 }]);
    expect((await owner.query("SELECT pack_id FROM public.catalog_definition_installs WHERE pack_id=$1", [different.id])).rows).toEqual([]);

    await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(await install(first, winner)).toEqual(receipt);
    await expect(install(first, request("example:new", [ref], [])))
      .rejects.toMatchObject({ code: "25000", message: "catalog_profile_install_requires_read_committed" });
    await first.query("ROLLBACK");
    const immutable = { code: "55000", message: "catalog_definition_install_profile_immutable" };
    await expect(owner.query("UPDATE public.catalog_definition_installs SET receipt=receipt WHERE pack_id=$1", [equal.id]))
      .rejects.toMatchObject(immutable);
    await expect(owner.query("DELETE FROM public.catalog_definition_installs WHERE pack_id=$1", [winner.id]))
      .rejects.toMatchObject(immutable);
    await expect(install(owner, request(winner.id, [ref], [declaration(ref, 29)])))
      .rejects.toMatchObject({ code: "23505", message: "catalog_definition_install_conflict" });
  } finally {
    try { await first.query("ROLLBACK"); await waiters; }
    finally { first.release(); equalClient.release(); differentClient.release(); }
  }
});

it("resolves every exact ref under the install lock and rolls back a missing reference", async () => {
  const profile = { key: "example:atomic", version: 1 };
  const missing = { ...profile, version: 2 };
  const anchor = request("example:atomic", [profile, missing], [declaration(profile)]);
  const refusal = await install(owner, anchor).catch((error: unknown) => error);
  expect(refusal).toMatchObject({ code: "22023", message: "definition_unknown_profile_ref", detail: expect.any(String) });
  expect(JSON.parse((refusal as { detail: string }).detail)).toEqual(missing);
  expect((await owner.query(`SELECT 1 FROM ${receiptTable} WHERE profile_key=$1`, [profile.key])).rows).toEqual([]);
  expect((await owner.query("SELECT 1 FROM public.catalog_definition_installs WHERE pack_id=$1", [anchor.id])).rows).toEqual([]);
  await install(owner, request(anchor.id, [profile], [declaration(profile)]));
  expect(await install(owner, request("example:reference", [profile], [])))
    .toMatchObject({ subscriptionProfileDefinitions: [] });
  await expect(install(owner, request("example:missing", [missing], [])))
    .rejects.toMatchObject({ code: "22023", message: "definition_unknown_profile_ref" });
});
