import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import { canonicalCatalogDraftJson, catalogDefinitionDigest, catalogPackManifest, createCatalogDefinitionWriteGuard, createCatalogProductTypeRegistry,
  installCatalogDefinitions, observeCatalogDefinitionReadiness, readInstalledCatalogSubscriptionProfile, withCatalogPublicationRules } from "@openlup/platform/catalog";
import type { CatalogPackInput } from "@openlup/platform/catalog/contracts";
import { verifyApp } from "@openlup/platform/lifecycle";
import { selectCatalogProfileCadence } from "@openlup/platform/subscriptions";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const root = "db/platform/migrations/";
const profileForward = `${root}20261124210000_subscription_profiles.sql`;
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
let legacyReceipt: Awaited<ReturnType<typeof installCatalogDefinitions>>;

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-profiles-${process.pid}`, password: "synthetic-profiles" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue profile PostgreSQL unavailable");
  const bootstrap = new Pool({ connectionString: container.connectionString }); pools.push(bootstrap);
  await bootstrap.query("CREATE ROLE profile_owner LOGIN SUPERUSER PASSWORD 'synthetic-profiles'; CREATE ROLE service_role NOLOGIN; ALTER DATABASE postgres OWNER TO profile_owner");
  const login = new URL(container.connectionString); login.username = "profile_owner";
  owner = new Pool({ connectionString: login.toString() }); pools.push(owner);
  for (const { file } of [manifest.baseline, ...manifest.forward]) {
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
  const write = vi.fn(async () => "called");
  const digest = catalogDefinitionDigest(seed.types[0]!);
  const expectProfileRefusal = async (profiles: readonly CatalogSubscriptionProfileV1[], reason: string) => {
    const catalogRegistry = await observeCatalogDefinitionReadiness(owner, registry, "catalog-db", profiles);
    expect(catalogRegistry.referencedVersions).toEqual([{
      key: type.key, version: type.version, definitionDigest: digest, registryDigest: digest,
      profileBindingIssue: { key: profile.key, version: profile.version, reason },
    }]);
    const report = await verifyApp({
      candidate: { artifact: "test", configuration: "test", environment: "test", database: "catalog-db", schema: "test" },
      inventoryComplete: true, loadedPackages: [{ name: "@openlup/core", version: "1.3.0", kind: "kernel" }],
      contributions: [], vocabulary: [], exemptions: [], bindings: { ports: {}, routes: {}, triggers: {}, env: {} },
      schemaProbe: { observe: async () => { throw new Error("not required"); } }, catalogRegistry,
    });
    const code = "catalog_profile_binding_invalid";
    expect(report.findings).toEqual([expect.objectContaining({
      code, subject: `${profile.key}@${profile.version}`, fix: expect.stringContaining("catalogue profile binding"),
    })]);
    const guard = createCatalogDefinitionWriteGuard(owner, registry, profiles);
    await expect(guard(write)).rejects.toMatchObject({
      code, reason, profileKey: profile.key, profileVersion: profile.version, fix: expect.stringContaining("catalogue profile binding"),
    });
  };
  await expectProfileRefusal([profile], "profile_binding_missing");
  expect(write).not.toHaveBeenCalled();
  await installCatalogDefinitions(owner, pack("guard-profile", profile));
  await expect(createCatalogDefinitionWriteGuard(owner, registry, [profile])(write)).resolves.toBe("called");
  await expectProfileRefusal([], "profile_binding_missing");
  await expectProfileRefusal([{ ...profile, policyDigest: "b".repeat(64) }], "profile_binding_mismatch");
  expect(write).toHaveBeenCalledTimes(1);
});

it("SP1-D-026 refuses reserved months and out-of-range declarations at install", async () => {
  const profile = { ...declaration, key: "example:limits", maxFixedDays: 120 };
  const input = pack("cadence", profile);
  const calendar = { schemaVersion: 1, kind: "calendar_months", months: 1 } as const;
  const unsupported = { ...profile, allowedCadences: [calendar] };
  await expect(installCatalogDefinitions(owner, pack("cadence", unsupported))).rejects.toMatchObject({
    issue: { code: "cadence_kind_unsupported", path: "/subscriptionProfileDefinitions/0/allowedCadences/0" },
  });
  const excessive = [
    { definition: { ...profile, allowedCadences: [fixed(3661)] }, path: "allowedCadences/0/days" },
    { definition: { ...profile, maxFixedDays: 3661 }, path: "maxFixedDays" },
  ];
  for (const { definition, path } of excessive) {
    await expect(installCatalogDefinitions(owner, pack("cadence", definition))).rejects.toMatchObject({
      issue: { code: "definition_profile_invalid", path: `/subscriptionProfileDefinitions/0/${path}` },
      fix: expect.stringContaining("1 to 3660"),
    });
  }
  const { digest: _digest, ...projection } = catalogPackManifest(input);
  const sqlInstall = (definition: CatalogSubscriptionProfileV1, profileDigest: string) => owner.query(
    "SELECT public.catalog_definition_install($1,$2,$3) AS receipt", [input.id, input.version, {
      manifest: canonicalCatalogDraftJson({ ...projection, subscriptionProfileDefinitions: [{ ...definition, profileDigest }] }),
      types: [], taxClasses: [],
    }]);
  for (const { definition } of excessive) {
    const digest = createHash("sha256").update(canonicalCatalogDraftJson(definition)).digest("hex");
    await expect(sqlInstall(definition, digest)).rejects.toMatchObject({ message: "definition_profile_invalid", code: "22023" });
  }
  const monthDigest = createHash("sha256").update(canonicalCatalogDraftJson(unsupported)).digest("hex");
  await expect(sqlInstall(unsupported, monthDigest)).rejects.toMatchObject({ message: "cadence_kind_unsupported", code: "22023" });
  await expect(sqlInstall(profile, "f".repeat(64))).rejects.toMatchObject({ message: "definition_profile_invalid", code: "22023" });
  expect(await readInstalledCatalogSubscriptionProfile(owner, profile)).toBeNull();
  await installCatalogDefinitions(owner, input);
  const installed = (await readInstalledCatalogSubscriptionProfile(owner, profile))!;
  const selection = { mode: "recurring", profileRef: profile, profile: { declaration: profile, installed },
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

it("SP1-D-026 leaves a narrower installed cadence limit to the native write guard", async () => {
  const connection = await owner.connect();
  const client = randomUUID(), subscription = randomUUID(), priceList = randomUUID();
  const profile = { ...declaration, key: "example:narrow-native-limit", allowedCadences: [fixed(90), fixed(91)] };
  try {
    await connection.query("BEGIN");
    // Restore the original issued quote constraint in this fixture transaction.
    await connection.query(`ALTER TABLE public.subscription_edit_quotes DROP CONSTRAINT subscription_edit_quotes_cadence_check;
      ALTER TABLE public.subscription_edit_quotes ADD CONSTRAINT subscription_edit_quotes_cadence_check
        CHECK (proposed_cadence_days BETWEEN 1 AND 90)`);
    await installCatalogDefinitions(connection, pack("narrow-native-limit", profile));
    const installed = (await readInstalledCatalogSubscriptionProfile(connection, profile))!;
    const selection = { mode: "recurring", profileRef: profile, profile: { declaration: profile, installed },
      storeChoices: profile.allowedCadences, skuChoices: profile.allowedCadences,
      offerChoices: profile.allowedCadences, commandChoices: profile.allowedCadences } as const;
    expect(selectCatalogProfileCadence({ ...selection, choice: fixed(91) })).toEqual({ cadenceDays: 91 });

    await connection.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
    await connection.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from)
      VALUES($1,'Cadence fixture','ZZ','XXX',now())`, [priceList]);
    await connection.query(`INSERT INTO public.subscriptions(id,client_id,status,cadence_days,next_cycle_at,started_at,price_list_id,currency_code)
      VALUES($1,$2,'active',90,now()+interval '90 days',now(),$3,'XXX')`, [subscription, client, priceList]);
    const writeQuote = (days: number) => connection.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,
      request_fingerprint,quote_hash,expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
      VALUES($1,$2,$3,$3,1,'[]',$4,100,100,'XXX',now()+interval '15 minutes') RETURNING proposed_cadence_days`,
    [subscription, `cadence-quote-${days}`, createHash("sha256").update(String(days)).digest("hex"), days]);
    expect((await writeQuote(90)).rows).toEqual([{ proposed_cadence_days: 90 }]);
    await expect(writeQuote(91)).rejects.toMatchObject({ code: "23514", constraint: "subscription_edit_quotes_cadence_check" });
  } finally {
    try { await connection.query("ROLLBACK"); } finally { connection.release(); }
  }
});
