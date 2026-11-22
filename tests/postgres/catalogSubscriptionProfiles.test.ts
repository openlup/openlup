import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import { canonicalCatalogDraftJson, catalogPackManifest, createCatalogDefinitionWriteGuard, createCatalogProductTypeRegistry,
  installCatalogDefinitions, readInstalledCatalogSubscriptionProfile, withCatalogPublicationRules } from "@openlup/platform/catalog";
import type { CatalogPackInput } from "@openlup/platform/catalog/contracts";
import { observeCatalogSubscriptionCadenceBound, selectCatalogProfileCadence } from "@openlup/platform/subscriptions";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const root = "db/platform/migrations/";
const profileForward = `${root}20261124210000_subscription_profiles.sql`;
const cadenceForward = `${root}20261122190000_subscription_cadence_bound.sql`;
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const artifact = readFileSync("examples/neutral-store/owned/catalogue-rules.cjs");
const ref = { key: "example:repeat", version: 1 };
const fixed = (days: number) => ({ schemaVersion: 1, kind: "fixed_days", days } as const);
const choices = [1, 120, 121, 3660].map(fixed);
const declaration: CatalogSubscriptionProfileV1 = {
  ...ref, allowedCadences: choices, policyRef: { key: "example:repeat-policy", version: 2 }, policyDigest: "a".repeat(64),
};
const pack = (id: string, profile?: CatalogSubscriptionProfileV1): CatalogPackInput => ({
  id: `example:${id}`, namespace: "example", version: 1, openlupRange: "1.x", capabilities: {},
  types: [], taxClasses: [], subscriptionProfiles: [profile ? { key: profile.key, version: profile.version } : ref],
  ...(profile && { subscriptionProfileDefinitions: [profile] }),
});
const pools: Pool[] = [];
let container: PostgresContainer, owner: Pool, runtime: Pool;
let legacyReceipt: Awaited<ReturnType<typeof installCatalogDefinitions>>, olderBound: number | null;

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-profiles-${process.pid}`, password: "synthetic-profiles" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue profile PostgreSQL unavailable");
  const bootstrap = new Pool({ connectionString: container.connectionString }); pools.push(bootstrap);
  await bootstrap.query("CREATE ROLE profile_owner LOGIN SUPERUSER PASSWORD 'synthetic-profiles'; CREATE ROLE service_role NOLOGIN; ALTER DATABASE postgres OWNER TO profile_owner");
  const login = new URL(container.connectionString); login.username = "profile_owner";
  owner = new Pool({ connectionString: login.toString() }); pools.push(owner);
  for (const { file } of [manifest.baseline, ...manifest.forward]) {
    if (file === cadenceForward) olderBound = await observeCatalogSubscriptionCadenceBound(owner);
    if (file === profileForward) legacyReceipt = await installCatalogDefinitions(owner, pack("reference-only"));
    await owner.query(readFileSync(file, "utf8"));
  }
  await bootstrap.query(`CREATE ROLE profile_runtime LOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS PASSWORD 'synthetic-profiles';
    GRANT service_role TO profile_runtime WITH INHERIT TRUE, SET TRUE;
    ALTER ROLE profile_owner NOSUPERUSER NOBYPASSRLS`);
  login.username = "profile_runtime";
  runtime = new Pool({ connectionString: login.toString() }); pools.push(runtime);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pools), postgresTeardownTimeoutMs);

it("SP1-D-022 permits a single immutable identity under contending installs", async () => {
  const first = await owner.connect(), second = await owner.connect();
  const initial = pack("first", declaration);
  try {
    const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await first.query("BEGIN");
    const receipt = await installCatalogDefinitions(first, initial);
    const contested = installCatalogDefinitions(second, pack("conflicting", { ...declaration, maxFixedDays: 120 }));
    const outcome = contested.then(() => null, (error: unknown) => error);
    await vi.waitFor(async () => {
      const { rows } = await owner.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [pid]);
      expect(rows).toHaveLength(1);
    });
    await first.query("COMMIT");
    expect(await outcome).toMatchObject({ message: "catalog_profile_install_refuses_redefinition", code: "23505" });
    expect((await owner.query("SELECT 1 FROM public.catalog_definition_installs WHERE pack_id='example:conflicting'")).rows).toEqual([]);

    const installed = { profileKey: ref.key, profileVersion: 1, profileDigest: receipt.subscriptionProfileDefinitions?.[0].profileDigest,
      policyRef: declaration.policyRef, policyDigest: declaration.policyDigest };
    expect(await readInstalledCatalogSubscriptionProfile(owner, ref)).toEqual(installed);
    await expect(readInstalledCatalogSubscriptionProfile(runtime, ref)).rejects.toMatchObject({ code: "42501" });
    expect(await readInstalledCatalogSubscriptionProfile(owner, { ...ref, version: 2 })).toBeNull();
    await installCatalogDefinitions(owner, pack("higher", { ...declaration, version: 2, maxFixedDays: 120 }));
    expect(await readInstalledCatalogSubscriptionProfile(owner, ref)).toEqual(installed);
    expect(await readInstalledCatalogSubscriptionProfile(owner, { ...ref, version: 2 })).toMatchObject({ profileVersion: 2 });
    const reordered = { ...declaration, allowedCadences: [...choices].reverse() };
    expect(await installCatalogDefinitions(owner, pack("first", reordered))).toEqual(receipt);
    expect(await installCatalogDefinitions(owner, pack("reference-only"))).toEqual(legacyReceipt);
    expect(legacyReceipt).not.toHaveProperty("subscriptionProfileDefinitions");
    expect(await installCatalogDefinitions(owner, pack("same-profile-other-pack", reordered))).toMatchObject({
      subscriptionProfileDefinitions: receipt.subscriptionProfileDefinitions,
    });
    await expect(owner.query("UPDATE public.catalog_definition_installs SET receipt = receipt WHERE pack_id='example:first'")).rejects.toMatchObject({ code: "55000" });
    await expect(owner.query("DELETE FROM public.catalog_definition_installs WHERE pack_id='example:first'")).rejects.toMatchObject({ code: "55000" });
    await expect(owner.query("UPDATE public.catalog_definition_installs SET receipt = receipt || '{\"subscriptionProfileDefinitions\":[]}' WHERE pack_id='example:reference-only'")).rejects.toMatchObject({ code: "55000" });
    expect(await installCatalogDefinitions(owner, initial)).toEqual(receipt);
  } finally {
    try { await first.query("ROLLBACK"); } finally { first.release(); second.release(); }
  }
});

it("requires the matching installed declaration in an opted-in metadata readiness guard", async () => {
  const profile = { ...declaration, key: "example:guard-profile" };
  const type = { key: "example:guard-item", version: 1, subscriptionProfileRef: { key: profile.key, version: profile.version },
    units: [{ code: "openlup:piece", dimension: "count" as const, integral: true }],
    netContentUnits: ["openlup:piece"], dimensions: [], validateContent: () => [] };
  const seed = withCatalogPublicationRules({ ...pack("guard"), types: [type], subscriptionProfiles: [type.subscriptionProfileRef] }, () => artifact);
  await installCatalogDefinitions(owner, seed);
  await owner.query(`INSERT INTO public.catalog_products(slug,name,type_key,type_version)
    VALUES('profile-guard','Synthetic profile guard','example:guard-item',1)`);
  const registry = createCatalogProductTypeRegistry(seed.types);
  const guard = createCatalogDefinitionWriteGuard(owner, registry, [profile]);
  const write = vi.fn(async () => "called");
  await expect(guard(write)).rejects.toMatchObject({ code: "registry_missing_referenced_version" });
  expect(write).not.toHaveBeenCalled();
  await installCatalogDefinitions(owner, pack("guard-profile", profile));
  await expect(guard(write)).resolves.toBe("called");
  const wrong = createCatalogDefinitionWriteGuard(owner, registry, [{ ...profile, policyDigest: "b".repeat(64) }]);
  await expect(wrong(write)).rejects.toMatchObject({ code: "registry_missing_referenced_version" });
  expect(write).toHaveBeenCalledTimes(1);
});

it("SP1-D-026 refuses reserved months at the native install boundary and observes fixed-day limits", async () => {
  expect(olderBound).toBe(90);
  const nativeMaxFixedDays = await observeCatalogSubscriptionCadenceBound(runtime);
  expect(nativeMaxFixedDays).toBe(3660);
  const profile = { ...declaration, key: "example:limits", maxFixedDays: 120 };
  const input = pack("cadence", profile);
  const calendar = { schemaVersion: 1, kind: "calendar_months", months: 1 } as const;
  const unsupported = { ...profile, allowedCadences: [calendar] };
  await expect(installCatalogDefinitions(owner, pack("cadence", unsupported))).rejects.toMatchObject({
    issue: { code: "cadence_kind_unsupported", path: "/subscriptionProfileDefinitions/0/allowedCadences/0" },
  });
  const { digest: _digest, ...projection } = catalogPackManifest(input);
  const sqlInstall = (definition: CatalogSubscriptionProfileV1, profileDigest: string) => owner.query(
    "SELECT public.catalog_definition_install($1,$2,$3) AS receipt", [input.id, input.version, {
      manifest: canonicalCatalogDraftJson({ ...projection, subscriptionProfileDefinitions: [{ ...definition, profileDigest }] }),
      types: [], taxClasses: [],
    }]);
  const monthDigest = createHash("sha256").update(canonicalCatalogDraftJson(unsupported)).digest("hex");
  await expect(sqlInstall(unsupported, monthDigest)).rejects.toMatchObject({ message: "cadence_kind_unsupported", code: "22023" });
  await expect(sqlInstall(profile, "f".repeat(64))).rejects.toMatchObject({ message: "definition_profile_invalid", code: "22023" });
  expect(await readInstalledCatalogSubscriptionProfile(owner, profile)).toBeNull();
  await installCatalogDefinitions(owner, input);
  const installed = (await readInstalledCatalogSubscriptionProfile(owner, profile))!;
  const selection = { mode: "recurring", profileRef: profile, profile: { declaration: profile, installed }, nativeMaxFixedDays,
    storeChoices: choices, skuChoices: choices, offerChoices: choices, commandChoices: choices } as const;
  expect(selectCatalogProfileCadence({ ...selection, choice: fixed(120) })).toEqual({ cadenceDays: 120 });
  expect(selectCatalogProfileCadence({ ...selection, choice: fixed(121) })).toEqual({ code: "cadence_not_offered" });
  const { maxFixedDays: _cap, ...localWithoutCap } = profile;
  expect(selectCatalogProfileCadence({ ...selection, choice: fixed(121), profile: { declaration: localWithoutCap, installed } }))
    .toEqual({ code: "policy_binding_missing" });
  expect(selectCatalogProfileCadence({ ...selection, choice: calendar })).toEqual({ code: "cadence_kind_unsupported" });
  const uncapped = { ...declaration, key: profile.key, version: 2 };
  await installCatalogDefinitions(owner, pack("uncapped", uncapped));
  const uncappedIdentity = (await readInstalledCatalogSubscriptionProfile(owner, uncapped))!;
  for (const days of [1, 121, 3660]) {
    expect(selectCatalogProfileCadence({ ...selection, choice: fixed(days), profileRef: uncapped,
      profile: { declaration: uncapped, installed: uncappedIdentity } })).toEqual({ cadenceDays: days });
  }
});

it("refuses an installed preview with an earlier guard or a commented-out bound", async () => {
  const connection = await owner.connect();
  try {
    await connection.query("BEGIN");
    const { rows } = await connection.query<{ definition: string }>(`SELECT pg_get_functiondef(
      'public.customer_subscription_preview_bundle_as_actor(uuid,text,jsonb,jsonb,jsonb,integer,integer)'::regprocedure) AS definition`);
    const original = rows[0].definition;
    const guard = "  IF v_cadence_days NOT BETWEEN 1 AND 3660 OR v_expected_version < 1 THEN";
    expect(original).toContain(guard);
    for (const replacement of [
      `  IF v_cadence_days > 120 THEN RAISE EXCEPTION 'subscription_edit_invalid_request'; END IF;
${guard}`,
      `  /*
${guard}
  */
  IF v_cadence_days < 1 OR v_cadence_days > 90 OR v_expected_version < 1 THEN`,
    ]) {
      await connection.query(original.replace(guard, replacement));
      expect(await observeCatalogSubscriptionCadenceBound(connection)).toBeNull();
    }
  } finally {
    try { await connection.query("ROLLBACK"); } finally { connection.release(); }
  }
  expect(await observeCatalogSubscriptionCadenceBound(runtime)).toBe(3660);
});
