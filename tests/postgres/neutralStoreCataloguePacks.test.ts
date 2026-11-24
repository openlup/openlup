import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { canonicalCatalogDraftJson, catalogPackManifest, catalogProductTypeIssues, installCatalogDefinitions, withCatalogPublicationRules } from "@openlup/platform/catalog";
import type { CatalogPackInput } from "@openlup/platform/catalog/contracts";
import type { CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from "@openlup/platform/migrations";
import { applyDemoSeed } from "../../examples/neutral-store/installation/install.ts";
import { installationReport } from "../../examples/neutral-store/installation/refusals.ts";
import { reconcileStarterCatalogue130 } from "../../scripts/packages/distribution-cli-proof.ts";
import { catalogueConformance } from "../../examples/neutral-store/owned/catalogue.ts";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

vi.mock("@openlup/platform/catalog", async importOriginal => {
  const catalog = await importOriginal<typeof import("@openlup/platform/catalog")>();
  return { ...catalog, catalogProductTypeIssues: vi.fn(catalog.catalogProductTypeIssues) };
});

const source = resolve("examples/neutral-store");
const rules = readFileSync(join(source, "owned/catalogue-rules.cjs"));
const starter = catalogueConformance.packs[0]!;
const config = configurations.coffee!;
const profileRef = { key: "example:repeat", version: 2 };
const profile: CatalogSubscriptionProfileV1 = { ...profileRef,
  allowedCadences: [{ schemaVersion: 1, kind: "fixed_days", days: 28 }],
  policyRef: { key: "example:policy", version: 1 }, policyDigest: createHash("sha256").update("fixture").digest("hex") };
const maxVersion = 2_147_483_647;
const pack = (name = "provider", version = 1, typeNames = [name]): CatalogPackInput => ({
  id: `example:${name}`, namespace: "example", version, openlupRange: "1.x", capabilities: { publish: false },
  types: typeNames.map(key => ({ key: `example:${key}`, version, dimensions: [], validateContent: () => [],
    units: [{ code: "openlup:piece", dimension: "count", integral: true }], netContentUnits: ["openlup:piece"], taxClass: "example:standard" })),
  taxClasses: [{ key: "example:standard" }, { key: `example:${name}` }],
});
const provider = { ...pack(), subscriptionProfiles: [profileRef], subscriptionProfileDefinitions: [profile] };
const second = pack("consumer", maxVersion, ["consumer", "another"]);
const consumer = { ...second, subscriptionProfiles: [profileRef], subscriptionProfileDefinitions: [],
  types: second.types.map(type => ({ ...type, subscriptionProfileRef: profileRef })) };
type Entry = { pack: CatalogPackInput; drafts: unknown[] };
const entry = (pack: CatalogPackInput): Entry => ({ pack, drafts: [] });
const catalogue = catalogueConformance as { packs: unknown };
const selection = { generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres",
  bootstrapLogin: "postgres", runtimeLogin: "starter_runtime", restoreLogin: "starter_restore" } as const;
const pools: Pool[] = [], containers: PostgresContainer[] = [];
let owner: Pool, runtime: Pool, container: PostgresContainer, scratch: string;
const up = "Run `./lifecycle up`.";
const sourceCheck = "Run `npm run catalogue:check:source`, then `./lifecycle up`.";

beforeAll(async () => {
  mkdirSync(resolve(".context/scratch"), { recursive: true });
  scratch = mkdtempSync(resolve(".context/scratch/st1-catalogue-"));
  container = await runPostgresContainer({ name: `starter-packs-${process.pid}`, database: "neutral_store", password: "synthetic-conformance" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue PostgreSQL unavailable");
  owner = new Pool({ connectionString: container.connectionString }); pools.push(owner);
  await owner.query(`CREATE ROLE starter_runtime LOGIN NOINHERIT PASSWORD 'synthetic-conformance';
    CREATE ROLE starter_restore LOGIN NOINHERIT; CREATE ROLE starter_effective NOLOGIN;
    COMMENT ON DATABASE neutral_store IS 'openlup-neutral-store-demo-v1'`);
  const migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  pools.push(migration);
  await createPlatformPostgresMigrationRunner({ connectionString: container.connectionString },
    { installation: selection, poolFactory: () => migration }).apply();
  const url = new URL(container.connectionString); url.username = "starter_runtime";
  runtime = new Pool({ connectionString: url.href }); pools.push(runtime);
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try { await closePostgres(containers, pools); } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}, postgresTeardownTimeoutMs);

const tables = ["catalog_definition_installs", "catalog_type_versions", "catalog_tax_classes",
  "catalog_subscription_profile_receipts", "catalog_products", "catalog_skus", "price_entries", "commerce_settings"];
async function snapshot(db: Pool = owner, names = tables) {
  return Promise.all(names.map(async table => (await db.query(
    `SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows.map(({ row }) => row)));
}
const writes = (statements: string[]) => statements.filter(text => /\b(?:INSERT|UPDATE|DELETE)\b|SELECT public\.catalog_definition_install\(/iu.test(text)
  && !/FOR UPDATE/iu.test(text));

async function run(packs: unknown, options: { bytes?: Uint8Array | null; db?: Pool; role?: string;
  statements?: string[]; builds?: string; after?: (text: string, client: PoolClient, values?: unknown[]) => void | Promise<void>; rulesFor?: () => Uint8Array | undefined } = {}) {
  const client = await (options.db ?? owner).connect();
  const previous = catalogue.packs;
  catalogue.packs = packs;
  try {
    if (options.role === "starter_effective") await client.query("SET ROLE starter_effective");
    const connection = { async query(text: string, values?: unknown[]) {
      options.statements?.push(text);
      const result = await client.query(text, values);
      await options.after?.(text, client, values);
      return result;
    } };
    return await applyDemoSeed(config, { connection, catalogueRules: options.bytes === null ? undefined : options.bytes ?? rules,
      catalogueBuildDirectory: options.builds ?? mkdtempSync(join(scratch, "builds-")),
      installRole: options.role ?? "postgres", runtimeRole: "starter_runtime", close: async () => {} }, options.rulesFor);
  } finally {
    catalogue.packs = previous;
    if (options.role === "starter_effective") await client.query("RESET ROLE");
    client.release();
  }
}

function refusal(error: unknown, code: string, path: string, observed: string, causeText: string, fix: string, recheck = up, original?: Error) {
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  const keys = ["causeText", "code", "fix", "message", "observed", "path", "recheck", ...(original ? ["cause"] : [])].sort();
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toEqual(keys);
  expect(error).toMatchObject({ code, message: code, path, observed, causeText, fix, recheck });
  if (original) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "cause");
    expect(descriptor).toEqual({ value: original, enumerable: false, configurable: true, writable: true });
    expect(descriptor?.value).toBe(original);
  }
  const output = `${code}\nObserved: ${observed.replaceAll("\n", "\\n")}\nCause: ${causeText}\nFix: ${fix}\nRecheck: ${recheck}\n`;
  expect(installationReport(error)).toBe(output);
  return output;
}

it("two_packs_three_types_install_with_tax_classes", async () => {
  const inputs = [starter, entry(provider), entry(consumer)];
  const before = JSON.stringify(inputs);
  const validators = inputs.flatMap(({ pack }) => pack.types.map(type => type.validateContent));
  expect((await owner.query("SELECT 1 FROM public.catalog_subscription_profile_receipts WHERE profile_key=$1", [profileRef.key])).rowCount).toBe(0);
  const statements: string[] = [];
  await run(inputs, { statements });
  expect(statements.filter(sql => sql.startsWith("SELECT public.catalog_definition_install("))).toHaveLength(3);
  const [receipts, types, taxes, profiles] = await snapshot(owner, tables.slice(0, 4));
  for (const input of [provider, consumer]) {
    const bound = withCatalogPublicationRules(input, () => rules);
    const row = receipts!.find(receipt => receipt.pack_id === input.id);
    expect(row.receipt.canonicalManifest).toBe(canonicalCatalogDraftJson(
      Object.fromEntries(Object.entries(catalogPackManifest(bound)).filter(([key]) => key !== "digest"))));
    expect(row.receipt).toMatchObject({ packId: input.id, packVersion: input.version, types: input.types.map(({ key, version }) => ({ key, version })) });
    for (const type of input.types) {
      const persisted = types!.find(row => row.type_key === type.key && row.version === type.version);
      const { validateContent: _callback, ...expected } = type;
      const { validatorRef: _validatorRef, publicationRules: _rules, ...actual } = persisted.definition;
      expect(actual).toEqual(expected);
    }
    expect(taxes!.map(row => row.key)).toEqual(expect.arrayContaining(input.taxClasses.map(({ key }) => key)));
  }
  expect(profiles).toContainEqual(expect.objectContaining({ profile_key: profileRef.key, profile_version: profileRef.version, pack_id: provider.id }));
  expect(JSON.stringify(inputs)).toBe(before);
  expect(inputs.flatMap(({ pack }) => pack.types.map(type => type.validateContent))).toEqual(validators);
});

it("second_install_is_idempotent", async () => {
  const inputs = [starter, entry(pack("replay"))];
  await run(inputs);
  const before = await snapshot();
  let started: number | undefined, packMs: number | undefined;
  const replay = await run(inputs, { after(text, _client, values) {
    if (text.startsWith("SELECT public.catalog_definition_install(") && values?.[0] === "starter:local-rules")
      started = performance.now();
    if (started !== undefined && text.startsWith("INSERT INTO public.catalog_products") && packMs === undefined)
      packMs = performance.now() - started;
  } });
  expect(replay.map(({ outcome }) => outcome)).toEqual(["unchanged"]);
  expect(packMs).toBeGreaterThan(0);
  console.log("Warm adopter ledger read, replay and build staging (ms)", Math.round(packMs!));
  expect((await snapshot()).slice(0, 4)).toEqual(before.slice(0, 4));
});

it("the existing definition lock orders adopter ledger readback after a competing commit", async () => {
  const candidate = pack("locked-report");
  const competing = await owner.connect();
  const statements: string[] = [];
  const builds = mkdtempSync(join(scratch, "locked-report-"));
  await competing.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  let installing: ReturnType<typeof run> | undefined;
  try {
    await installCatalogDefinitions(competing, withCatalogPublicationRules(candidate, () => rules));
    installing = run([starter, entry(candidate)], { statements, builds });
    void installing.catch(() => {});
    await vi.waitFor(async () => {
      const waiting = await owner.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted");
      expect(waiting.rowCount).toBeGreaterThan(0);
    });
    expect(statements.some(text => text.startsWith("SELECT 1 FROM public.catalog_definition_installs"))).toBe(false);
  } finally {
    try { await competing.query("COMMIT"); } finally { competing.release(); }
  }
  const results = await installing;
  expect(results?.map(({ outcome }) => outcome)).toEqual(["unchanged"]);
  expect(readdirSync(join(builds, "packs"))).toEqual([`${candidate.id}@${candidate.version}.json`]);
});

it("changed_pack_same_version_refuses_version_conflict and rolls back a late seed failure", async () => {
  const installed = pack("immutable");
  let productId: unknown;
  await run([starter, entry(installed)], { after(sql, _client, values) {
    if (!productId && sql.includes("INSERT INTO public.catalog_products")) productId = values?.[0];
  } });
  const priorName = "Existing demo name before retry";
  expect((await owner.query("UPDATE public.catalog_products SET name=$2 WHERE id=$1", [productId, priorName])).rowCount).toBe(1);
  const before = await snapshot();
  const builds = mkdtempSync(join(scratch, "rollback-"));
  const inputs = [starter, entry(pack("new-first")), entry({ ...installed, capabilities: { publish: true } })];
  const error = await run(inputs, { builds }).catch(error => error);
  refusal(error, "starter_catalogue_pack_version_conflict", "/packs/2/pack/version",
    "The installed pack version has a different manifest.", "An installed pack identity is immutable.",
    "Restore the installed declaration and matching rules. For an intentional change, issue a new pack version and new versions for changed types or profiles, and update their references.");
  expect(await snapshot()).toEqual(before);
  const failure = new Error("synthetic late seed failure");
  let changed = false;
  const result = await run(inputs.slice(0, 2), { builds, async after(sql, client, values) {
    if (!sql.includes("INSERT INTO public.catalog_products")) return;
    expect(values?.[0]).toBe(productId);
    const { rows } = await client.query("SELECT name FROM public.catalog_products WHERE id=$1", [productId]);
    expect(rows[0]?.name).toBe(values?.[3]);
    expect(rows[0]?.name).not.toBe(priorName);
    changed = true;
    throw failure;
  } }).catch(error => error);
  expect(changed).toBe(true);
  expect(result).toMatchObject({ code: "starter_installation_failed" });
  expect(Object.getOwnPropertyDescriptor(result, "cause")?.value).toBe(failure);
  expect(await snapshot()).toEqual(before);
  expect(readdirSync(builds)).toEqual(["packs"]);
  expect(readdirSync(join(builds, "packs"))).toEqual([]);
});

it.each([
  ["starter_catalogue_type_redefinition", "/types", { ...pack("replay-redefinition"),
    types: pack("replay").types.map(type => ({ ...type, dimensions: [{ key: "flag", kind: "boolean" as const }] })) }],
  ["starter_catalogue_profile_redefinition", "/subscriptionProfileDefinitions", { ...provider, id: "example:other-profile-owner",
    subscriptionProfileDefinitions: [{ ...profile, allowedCadences: [{ schemaVersion: 1, kind: "fixed_days", days: 34 }] }] }],
  ["starter_catalogue_profile_ref_missing", "/subscriptionProfiles/0", { ...consumer, id: "example:missing",
    subscriptionProfiles: [{ ...profileRef, version: 99 }], types: [] }],
] as const)("changed_pack_same_version_refuses_version_conflict covers %s", async (code, path, input) => {
  if (code === "starter_catalogue_type_redefinition") await run([starter, entry(pack("replay"))]);
  if (code === "starter_catalogue_profile_redefinition") await run([starter, entry(provider)]);
  const before = await snapshot();
  const error = await run([starter, entry(input)]).catch(error => error);
  const fields = {
    starter_catalogue_type_redefinition: ["The pack attempts to change an installed type version.",
      "An installed type version is immutable across packs.",
      "Restore the installed type definition, or issue a new type version and update referencing declarations and the pack version as needed."],
    starter_catalogue_profile_redefinition: ["The pack attempts to change an installed profile version.",
      "An installed profile version is immutable across packs.",
      "Restore the installed profile definition, or issue a new profile version and update referencing declarations and the pack version as needed."],
    starter_catalogue_profile_ref_missing: ["The declared profile reference example:repeat@99 is missing from the installed profile receipts.",
      "The exact profile version is absent from installed profile receipts.",
      "Declare the referenced profile version in its owning pack and install that pack before the consumer, or reference an already installed compatible version."],
  } as const;
  const [observed, causeText, fix] = fields[code];
  refusal(error, code, "/packs/1/pack" + path, observed, causeText, fix);
  expect(await snapshot()).toEqual(before);
});

it("packs_without_rules_refuse_before_any_write and distinguish bad declarations and rules", async () => {
  const before = await snapshot();
  const builds = mkdtempSync(join(scratch, "unwritten-"));
  const statements: string[] = [];
  const failure = await run([starter, entry(pack())], { bytes: null, builds, statements }).catch(error => error);
  const text = refusal(failure, "starter_catalogue_rules_required", "owned/catalogue-rules.cjs",
    "The rules file is absent for 1 adopter packs.", "Installing an adopter pack requires a publication rules bundle.",
    "Add the rules module at `owned/catalogue-rules.cjs` using the starter's rules skeleton, then rebuild the demonstration image through the lifecycle command.");
  expect(text.split("\n")).toHaveLength(6);
  const huge = { ["z".repeat(1_048_576)]: true };
  const invalid = [0, maxVersion + 1, 1.5, "1"].flatMap(version => [
    { ...pack(), version }, { ...pack(), types: [{ ...pack().types[0], version }] },
  ]);
  for (const declaration of [...invalid, { ...pack(), taxClasses: [{ key: "example:standard" }, { key: "example:standard" }] },
    { ...pack(), capabilities: huge }, { ...provider, capabilities: huge }, { ...pack(), "forged\nline": true }]) {
    await expect(run([starter, { pack: declaration, drafts: [] }], { builds, statements }))
      .rejects.toMatchObject({ code: "starter_catalogue_pack_invalid", path: expect.stringMatching(/^\/packs\/1\/pack/u) });
  }
  await expect(run(Array(1), { bytes: null, builds, statements })).rejects.toMatchObject({ code: "starter_catalogue_pack_invalid", path: "/packs/0" });
  await expect(run([starter, entry({ ...pack(), namespace: "starter" })], { bytes: null, builds, statements }))
    .rejects.toMatchObject({ code: "starter_catalogue_rules_required" });
  const original = Object.assign(new Error("synthetic unreadable file"), { code: "EACCES", hint: "raw diagnostic" });
  const infrastructure = await run([starter, entry(pack())], { builds, statements, rulesFor() { throw original; } }).catch(error => error);
  refusal(infrastructure, "starter_installation_failed", "owned/catalogue-rules.cjs", "The demonstration installation did not complete.",
    "The starter did not receive a verified result from the installation boundary.",
    "Check image dependencies, rules-file access, database reachability, TLS and driver initialization, installer login and grants, and the complete qualified migration set. Use the starter's default transaction isolation. For a receipt integrity failure, verify the installed package and schema pair before replaying the same declaration.",
    "Run `./lifecycle up` after correcting the failed prerequisite.", original);
  const malformed = await run([starter, entry(pack())], { bytes: Buffer.from("module.exports={}"), builds, statements }).catch(error => error);
  refusal(malformed, "starter_catalogue_rules_invalid", "/packs/1/pack/types/0/validatorRef",
    "The declared rules bundle could not be bound to the affected pack type.",
    "The bundle fails the installed rules contract or disagrees with an existing declared validator binding.",
    "Supply the artifact to withCatalogPublicationRules for each affected type and install the returned pack. Restore the original artifact for an existing binding. For a new definition, correct the module exports and use a matching artifact. Give intentional rule changes a new pack and affected type version.",
    "Run `node --test owned/catalogue-rules.test.cjs`, then `./lifecycle up`.");
  expect(writes(statements)).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(readdirSync(builds)).toEqual([]);
});

it("starter_namespace_refuses_pack_invalid for the later duplicate, after earlier declaration findings", async () => {
  const before = await snapshot();
  const statements: string[] = [];
  const builds = mkdtempSync(join(scratch, "duplicate-"));
  const first = pack("duplicate");
  const second = { ...first, id: "example:duplicate-second" };
  for (const [declarations, finding, path] of [
    [[starter, entry(first), entry(second)], "definition_duplicate_identity", "/packs/2/pack/types/0/key"],
    [[starter, entry({ ...first, version: 0 }), entry(second), entry(first)], "definition_version_invalid", "/packs/1/pack/version"],
    [[starter, entry(first), entry({ ...second, version: 0 })], "definition_version_invalid", "/packs/2/pack/version"],
    [[starter, entry(first), entry({ ...second, types: [{ ...second.types[0]!, validatorRef: `sha256:${"0".repeat(64)}` }] })],
      "definition_duplicate_identity", "/packs/2/pack/types/0/key"],
  ] as const) {
    const error = await run(declarations, { statements, builds }).catch(error => error);
    refusal(error, "starter_catalogue_pack_invalid", path, `The adopter pack has finding ${finding} at ${path}.`,
      "The declaration fails an offline catalogue definition check or an installation requirement identified by the finding.",
      "Correct the declaration at the reported path. Use the source check for its definition findings, then run the installer to verify installation requirements.",
      sourceCheck);
  }
  await expect(run([starter, entry(first), entry({ ...second, id: "starter-duplicate" })], { statements, builds }))
    .rejects.toMatchObject({ code: "starter_catalogue_pack_invalid", path: "/packs/2/pack/id" });
  expect(writes(statements)).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(readdirSync(builds)).toEqual([]);
});

it("starter_namespace_refuses_pack_invalid checks the 128-pack adopter list in one duplicate pass", async () => {
  const packs = Array.from({ length: 128 }, (_, index) => entry(pack(`adopter-${index}`, 1,
    Array.from({ length: 4 }, (_, type) => `adopter-${index}-type-${type}`))));
  const duplicateCheck = vi.mocked(catalogProductTypeIssues);
  duplicateCheck.mockClear();
  const statements: string[] = [];
  await expect(run([starter, ...packs], { db: runtime, statements }))
    .rejects.toMatchObject({ code: "starter_seed_runtime_role_forbidden" });
  expect(duplicateCheck.mock.calls.map(([types]) => types.length)).toEqual([512]);
  expect(writes(statements)).toEqual([]);
});

it("packs_without_rules_refuse_before_any_write for an oversized type in both pack forms", async () => {
  const before = await snapshot();
  const statements: string[] = [];
  const builds = mkdtempSync(join(scratch, "oversized-type-"));
  const dimensions = Array.from({ length: 16 }, (_, index) => ({ key: `extra-${index}`, kind: "choice" as const,
    values: Array.from({ length: 1000 }, (_, value) => `value-${value}-${"a".repeat(96)}`) }));
  for (const input of [pack(), provider]) {
    const path = "/packs/1/pack/types/0";
    const error = await run([starter, entry({ ...input, types: [{ ...input.types[0]!, dimensions }] })], { statements, builds }).catch(error => error);
    refusal(error, "starter_catalogue_pack_invalid", path, `The adopter pack has finding draft_payload_too_large at ${path}.`,
      "The declaration fails an offline catalogue definition check or an installation requirement identified by the finding.",
      "Correct the declaration at the reported path. Use the source check for its definition findings, then run the installer to verify installation requirements.",
      sourceCheck);
  }
  expect(writes(statements)).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(readdirSync(builds)).toEqual([]);
});

it.each(["starter", "starter:else", "starter:only-id", "starter-more", "starterish"])("starter_namespace_refuses_pack_invalid (%s)", async id => {
  const name = id === "starter" ? "elsewhere" : id;
  const statements: string[] = [];
  const candidate = { ...pack(), id: name, namespace: id === "starter" || id === "starter:else" ? "starter" : "example" };
  const field = candidate.namespace === "starter" ? "namespace" : "id";
  const path = `/packs/1/pack/${field}`;
  refusal(await run([starter, entry(candidate)], { statements }).catch(error => error), "starter_catalogue_pack_invalid",
    path, `The adopter pack uses a reserved starter identity at ${path}.`, "The starter reserves the namespace `starter` and IDs beginning with `starter`.",
    "Use an application-owned pack ID and namespace, and update affected type keys and owned fixture references to match.",
    "Run `./lifecycle up`. The source check alone does not enforce this reservation.");
  expect(writes(statements)).toEqual([]);
});

it("runtime_login_cannot_install", async () => {
  const before = await snapshot();
  await owner.query("GRANT starter_effective TO starter_runtime WITH SET TRUE");
  try {
    for (const role of [undefined, "starter_effective"]) {
      const statements: string[] = [];
      const error = await run([starter, entry(pack("runtime"))], { db: runtime, role, statements }).catch(error => error);
      refusal(error, "starter_seed_runtime_role_forbidden", "", "The seed connection used the configured runtime login or effective role.",
        "Runtime connections cannot install catalogue definitions.",
        "Start the demo through its installation service with the installer login. Keep the runtime grants restricted.");
      expect(writes(statements)).toEqual([]);
    }
  } finally { await owner.query("REVOKE starter_effective FROM starter_runtime"); }
  await expect(runtime.query("SELECT public.catalog_definition_install('example:runtime',1,'{}'::jsonb)")).rejects.toMatchObject({ code: "42501" });
  expect(await snapshot()).toEqual(before);
});

function materialize() {
  const app = mkdtempSync(join(scratch, "app-"));
  for (const path of ["host", "shared", "owned", "installation", "lifecycle.mjs", "lifecycle-refusals.mjs", "browser-groups.mjs", "package.json"])
    cpSync(join(source, path), join(app, path), { recursive: true });
  return app;
}

it("packs_without_rules_refuse_before_any_write through the one-shot text entry, then install after repair", async () => {
  const app = materialize(), before = await snapshot();
  const vars = { db: container.connectionString, builds: join(app, "builds") };
  mkdirSync(vars.builds);
  const declaration = join(app, "owned/catalogue.ts");
  const baseline = readFileSync(declaration, "utf8");
  const rulesPath = join(app, "owned/catalogue-rules.cjs");
  rmSync(rulesPath);
  // Retain the actual one-shot renderer and admission. Bind its disposable database to the harness.
  writeFileSync(join(app, "preload.mjs"), `import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, ctx, next) {
      if (specifier === "./installation/install.ts" && ctx.parentURL?.endsWith("/lifecycle.mjs")) return next("./witness.mjs", ctx);
      return next(specifier, ctx);
    } });`);
  writeFileSync(join(app, "witness.mjs"), `
    import pg from "pg";
    import { appendFileSync, readFileSync } from "node:fs";
    import { applyDemoSeed } from "./installation/install.ts";
    export const bootstrapDemonstration = null;
    export async function installDemonstration(config) {
      const client = new pg.Client({ connectionString: ${JSON.stringify(vars.db)} });
      await client.connect();
      try {
        await applyDemoSeed(config, { connection: { query(text, values) {
          appendFileSync("statements", text + "\\n"); return client.query(text, values);
        } }, installRole: "postgres", runtimeRole: "starter_runtime", catalogueBuildDirectory: ${JSON.stringify(vars.builds)} }, () => {
          try { return readFileSync("owned/catalogue-rules.cjs"); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        });
      } finally { await client.end(); }
    }`);
  const launch = (preload = "./preload.mjs") => spawnSync(process.execPath,
    ["--import", preload, "lifecycle.mjs", "install", "--configuration", "coffee"], { cwd: app, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
  const candidate = JSON.stringify(pack("cli-repair"));
  let declarationBase = baseline;
  const add = (bytes: string) => writeFileSync(declaration, declarationBase + bytes);
  writeFileSync(join(app, "statements"), "");
  add("catalogueConformance.packs.length = 2;\n");
  let result = launch();
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("starter_catalogue_pack_invalid\nObserved: The adopter pack has finding conformance_subject_invalid at /packs/1.\n"
    + "Cause: The declaration fails an offline catalogue definition check or an installation requirement identified by the finding.\n"
    + "Fix: Correct the declaration at the reported path. Use the source check for its definition findings, then run the installer to verify installation requirements.\n"
    + "Recheck: " + sourceCheck + "\n");
  const appendPack = (extra = "") => add(`const adopter = ${candidate}; adopter.types[0].validateContent = () => []; ${extra}
    catalogueConformance.packs.push({ pack: adopter, drafts: [] });\n`);
  appendPack('adopter.namespace = "starter";');
  result = launch();
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("starter_catalogue_rules_required\nObserved: The rules file is absent for 1 adopter packs.\n"
    + "Cause: Installing an adopter pack requires a publication rules bundle.\n"
    + "Fix: Add the rules module at `owned/catalogue-rules.cjs` using the starter's rules skeleton, then rebuild the demonstration image through the lifecycle command.\n"
    + "Recheck: " + up + "\n");
  mkdirSync(rulesPath);
  result = launch();
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/^starter_installation_failed\nObserved: The demonstration installation did not complete\.\n/u);
  expect(result.stderr.split("\n")).toHaveLength(6);
  rmSync(rulesPath, { recursive: true });
  writeFileSync(rulesPath, rules);
  appendPack('adopter["forged\\nline"] = true;');
  result = launch();
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("starter_catalogue_pack_invalid\nObserved: The adopter pack has finding definition_unknown_field at /packs/1/pack/forged\\nline.\n"
    + "Cause: The declaration fails an offline catalogue definition check or an installation requirement identified by the finding.\n"
    + "Fix: Correct the declaration at the reported path. Use the source check for its definition findings, then run the installer to verify installation requirements.\n"
    + "Recheck: " + sourceCheck + "\n");
  const largeKey = "x".repeat(100_000);
  appendPack(`adopter[${JSON.stringify(largeKey)}] = true;`);
  result = launch();
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("starter_catalogue_pack_invalid\nObserved: The adopter pack has finding definition_unknown_field at /packs/1/pack/" + largeKey + ".\n"
    + "Cause: The declaration fails an offline catalogue definition check or an installation requirement identified by the finding.\n"
    + "Fix: Correct the declaration at the reported path. Use the source check for its definition findings, then run the installer to verify installation requirements.\n"
    + "Recheck: " + sourceCheck + "\n");
  const predecessor = execFileSync("git", ["show", "openlup-core-v1.3.0:examples/neutral-store/owned/catalogue.ts"], { encoding: "utf8" })
    .replace("title_required", "retained_title_required");
  writeFileSync(declaration, predecessor);
  result = launch();
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("starter_catalogue_pack_invalid\nObserved: The owned catalogue module does not export catalogueConformance.\n"
    + "Cause: The installer requires catalogueConformance.packs to read adopter pack declarations.\n"
    + "Fix: Add the catalogueConformance export to owned/catalogue.ts as the upgrade guide's owned-module step describes, keeping your existing validator and drafts.\n"
    + "Recheck: " + sourceCheck + "\n");
  declarationBase = reconcileStarterCatalogue130(predecessor, baseline);
  expect(readFileSync(join(app, "statements"), "utf8")).toBe("");
  expect(readdirSync(vars.builds)).toEqual([]);
  expect(await snapshot()).toEqual(before);
  appendPack();
  execFileSync(process.execPath, ["--test", "owned/catalogue-rules.test.cjs"], { cwd: app, stdio: "pipe" });
  result = launch();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect((await owner.query("SELECT pack_id FROM public.catalog_definition_installs WHERE pack_id='example:cli-repair'")).rows)
    .toEqual([{ pack_id: "example:cli-repair" }]);
}, 90_000);

it("packs_without_rules_refuse_before_any_write reports dependency loading and the missing migration binding", () => {
  const app = materialize();
  writeFileSync(join(app, "import-fails.mjs"), `import { registerHooks } from "node:module";
    globalThis.knownImportFailure = new Error("private injected dependency diagnostic");
    registerHooks({ resolve(specifier, ctx, next) {
      if (ctx.parentURL?.endsWith("/lifecycle.mjs")) {
        if (specifier === "./installation/install.ts") throw globalThis.knownImportFailure;
        if (specifier === "./installation/refusals.ts") return next("./check-cause.mjs", ctx);
      }
      return next(specifier, ctx);
    } });`);
  writeFileSync(join(app, "check-cause.mjs"), `import assert from "node:assert/strict";
    import { installationReport as render } from "./installation/refusals.ts";
    export { installationFailure, installationFinding, refusal } from "./installation/refusals.ts";
    export function installationReport(error) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "cause");
      if (globalThis.knownImportFailure) {
        assert.equal(descriptor?.value, globalThis.knownImportFailure);
        assert.equal(descriptor?.enumerable, false);
      } else assert.equal(descriptor, undefined);
      return render(error);
    }`);
  writeFileSync(join(app, "missing-api.mjs"), `import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, ctx, next) {
      if (specifier === "./installation/refusals.ts" && ctx.parentURL?.endsWith("/lifecycle.mjs"))
        return next("./check-cause.mjs", ctx);
      return next(specifier === "@openlup/platform/migrations" ? "data:text/javascript,export{}" : specifier, ctx);
    } });`);
  const launch = (preload: string) => spawnSync(process.execPath, ["--import", preload, "lifecycle.mjs", "install",
    "--configuration", "coffee"], { cwd: app, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
  const importFailure = launch("./import-fails.mjs");
  expect(importFailure.status).toBe(2);
  expect(importFailure.stderr).toBe("starter_installation_failed\nObserved: The demonstration installation did not complete.\n"
    + "Cause: The starter did not receive a verified result from the installation boundary.\n"
    + "Fix: Check image dependencies, rules-file access, database reachability, TLS and driver initialization, installer login and grants, and the complete qualified migration set. Use the starter's default transaction isolation. For a receipt integrity failure, verify the installed package and schema pair before replaying the same declaration.\n"
    + "Recheck: Run `./lifecycle up` after correcting the failed prerequisite.\n");
  const missing = launch("./missing-api.mjs");
  expect(missing.status).toBe(2);
  expect(missing.stderr).toBe("starter_installation_binding_required\nObserved: The installed @openlup/platform package does not provide the migration composition the demo installer needs.\n"
    + "Cause: The demo installer requires the qualified platform migration runner from the pinned package.\n"
    + "Fix: Install the exact @openlup/platform version pinned in the starter's package.json, then rebuild the demonstration image through the lifecycle command.\n"
    + "Recheck: " + up + "\n");
});

it("app_with_only_starter_pack_installs_as_today including an empty list with no bundle", async () => {
  const baseline = materialize();
  for (const path of ["installation/install.ts", "host/editor-catalogue.ts"]) {
    writeFileSync(join(baseline, path), execFileSync("git", ["show", `7b5329459:examples/neutral-store/${path}`]));
  }
  const legacy = await runPostgresContainer({ name: `starter-legacy-packs-${process.pid}`, database: "legacy_template", password: "synthetic-conformance" });
  containers.push(legacy);
  if (!await waitForPostgresTcpReady(legacy.connectionString)) throw new Error("Legacy catalogue PostgreSQL unavailable");
  const systemUrl = new URL(legacy.connectionString); systemUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: systemUrl.href }); pools.push(admin);
  await admin.query("CREATE ROLE starter_runtime LOGIN NOINHERIT; CREATE ROLE starter_restore LOGIN NOINHERIT");
  const templateUrl = new URL(legacy.connectionString);
  const template = new Pool({ connectionString: templateUrl.href, options: qualifiedPostgresStartupOptions(selection) });
  try {
    await createPlatformPostgresMigrationRunner({ connectionString: templateUrl.href },
      { installation: selection, poolFactory: () => template }).apply();
  } finally { await template.end(); }
  let absent: unknown;
  for (const [useRules, empty] of [[true, false], [false, false], [false, true]] as const) {
    const trials: unknown[] = [];
    for (const prior of empty ? [false] : [true, false]) {
      const name = `starter_${useRules ? "rules" : empty ? "empty" : "no_rules"}_${prior ? "prior" : "now"}`;
      // The source database is the migrated template; this command refuses concurrent template use.
      await admin.query(`CREATE DATABASE ${name} TEMPLATE legacy_template`);
      await admin.query(`COMMENT ON DATABASE ${name} IS 'openlup-neutral-store-demo-v1'`);
      const url = new URL(legacy.connectionString); url.pathname = "/" + name;
      const db = new Pool({ connectionString: url.href }); pools.push(db);
      const builds = mkdtempSync(join(scratch, "baseline-builds-"));
      if (prior) {
        const scenario = `import pg from 'pg'; import { applyDemoSeed } from './installation/install.ts';
          import { configurations } from './owned/store.config.ts'; import { readFileSync } from 'node:fs';
          const client = new pg.Client({ connectionString: ${JSON.stringify(url.href)} }); await client.connect();
          try { await applyDemoSeed(configurations.coffee, { connection: client, installRole: 'postgres', runtimeRole: 'starter_runtime',
            catalogueRules: ${useRules ? "readFileSync('owned/catalogue-rules.cjs')" : "undefined"}, catalogueBuildDirectory: ${JSON.stringify(builds)} }); }
          finally { await client.end(); }`;
        execFileSync(process.execPath, ["--input-type=module", "-e", scenario], { cwd: baseline, timeout: 30_000 });
      } else await run(empty ? [] : [starter], { db, builds, bytes: useRules ? rules : null });
      const objects = (await db.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      const definitions = await snapshot(db, tables.slice(0, 4));
      // The ledger and definition rows record their own install clocks. Canonical definitions and IDs are deterministic.
      for (const row of definitions[0]!) delete row.receipt.installedAt;
      for (const row of [...definitions[0]!, ...definitions[1]!]) delete row.installed_at;
      const links = readdirSync(builds).map(name => [name, readFileSync(join(builds, name))]);
      trials.push({ objects, definitions, links });
    }
    if (empty) expect(trials[0]).toEqual(absent);
    else {
      expect(trials[0]).toEqual(trials[1]);
      if (!useRules) absent = trials[1];
    }
  }
  await expect(run([])).rejects.toThrow("Define starter:item at version 1 in owned/catalogue.ts to install catalogue rules.");
}, 120_000);
