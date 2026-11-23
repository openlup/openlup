import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CatalogDraftPayloadV3, CatalogPackInput, CatalogPublicationCommand } from "@openlup/platform/catalog";
import type { CatalogConformanceReport } from "@openlup/platform/catalog/testing";
import { hash, transaction } from "./catalogPublicationFixture.js";

type Entry = { pack: CatalogPackInput; drafts: CatalogDraftPayloadV3[] };
type Catalog = typeof import("@openlup/platform/catalog");

const cases = [
  { name: "supplements", code: "definition_unknown_tax_class", path: "/packs/0/pack/types/0/taxClass" },
  { name: "cosmetics", code: "option_missing", path: "/packs/0/combinations/0/input/incoming/0" },
  { name: "pet-food", code: "duplicate_trade_identifier", path: "/packs/0/drafts/0/skus/1/identifiers/0" },
] as const;
const source = resolve("examples/neutral-store");
const cli = resolve("packages/platform/src/lifecycle/openlup.mjs");
const example = (name: string) => resolve("examples/catalog-packs", name);
const sourceCheck = "npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue.ts --json";
const up = "./lifecycle up";
const health = String.raw`curl --fail --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4319/api/config`;
const satisfied = '"state":"satisfied"';
const excludedAdvisories = ["advisory_net_content_not_publishable", "advisory_unit_identifier_missing"];
const packageNames = ["core", "outbox", "platform"];
const managed = JSON.parse(readFileSync(join(source, "ownership.json"), "utf8")).managed as string[];
const ownedList = "  }, skus: [] }] }],";
const explicitList = "  }, skus: [] }] }] as { pack: CatalogPackInput; drafts: unknown[] }[],";
const recipeTimeout = 900_000;

let scratch: string;
let temporary: string;
let app: string;
let childEnv: NodeJS.ProcessEnv;
let composeUsed = false;
let bridge: Server | undefined;
const pools: Pool[] = [];
let installation: Promise<{ catalog: Catalog; db: Pool; entries: Map<string, Entry> }> | undefined;

beforeAll(() => {
  const parent = resolve(".context/scratch");
  mkdirSync(parent, { recursive: true });
  scratch = mkdtempSync(join(parent, "reference-packs-"));
  app = join(scratch, "starter");
  // The trusted catalogue CLI requires its projection directory outside any application tree.
  temporary = mkdtempSync(join(tmpdir(), "openlup-reference-packs-"));
  childEnv = { ...processEnvironment, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    COMPOSE_PROJECT_NAME: `reference-packs-${randomUUID()}`, COMPOSE_FILE: join(app, "compose.yaml") };
});

function executable(command: string, args: string[], cwd: string, input?: string): string {
  return execFileSync(command, args, { cwd, input, env: childEnv, encoding: "utf8", timeout: 240_000 });
}

function recipe(command: string, extra: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("sh", ["-ec", command], { cwd: app, env: { ...childEnv, ...extra },
    encoding: "utf8", timeout: 240_000 });
  if (result.error) throw result.error;
  expect(result.status, `${command}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

function report(output: string): CatalogConformanceReport {
  return JSON.parse(output) as CatalogConformanceReport;
}

function expectSatisfied(output: string, ignoreStarter = false) {
  expect(output).toContain(satisfied);
  const result = report(output);
  expect(result).toMatchObject({ state: "satisfied", exitCode: 0 });
  expect(result.findings.filter(finding => excludedAdvisories.includes(finding.code)
    && !(ignoreStarter && finding.path.startsWith("/packs/0/")))).toEqual([]);
}

afterAll(async () => {
  try {
    await Promise.all(pools.map(pool => pool.end()));
    if (bridge) await new Promise<void>((done, fail) => bridge!.close(error => error ? fail(error) : done()));
  } finally {
    try {
      if (composeUsed) executable("docker", ["compose", "down", "--volumes", "--rmi", "local", "--remove-orphans"], app);
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  }
}, 120_000);

it("reference_packs_check_offline", () => {
  const offline = join(scratch, "offline");
  mkdirSync(offline);
  writeFileSync(join(offline, "package.json"), '{"type":"module"}');
  const driver = join(offline, "check.ts");
  for (const { name, code, path } of cases) {
    const module = join(example(name), "pack.ts");
    readFileSync(module);
    const check = (fixture: "offlineFixture" | "negativeFixture") => {
      const required = fixture === "offlineFixture" ? ', requiredChecks: ["draft-content"]' : "";
      writeFileSync(driver, `import { ${fixture} } from ${JSON.stringify(pathToFileURL(module).href)};\n`
        + `export const catalogueConformance = { packs: [${fixture}]${required} };\n`);
      return spawnSync(process.execPath, [cli, "catalogue", "project", "--trusted-packs", driver, "--json"],
        { cwd: offline, env: childEnv, encoding: "utf8", timeout: 30_000 });
    };
    // The trusted projection executes the synchronous validator as well as these JSON fixtures.
    const positive = check("offlineFixture");
    expect(positive.status, `${name}\n${positive.stdout}\n${positive.stderr}`).toBe(0);
    expectSatisfied(positive.stdout);
    const negative = check("negativeFixture");
    expect(negative.status, `${name}\n${negative.stdout}\n${negative.stderr}`).toBe(1);
    expect(report(negative.stdout)).toMatchObject({ state: "violated", exitCode: 1 });
    expect(report(negative.stdout).findings.filter(finding => finding.severity === "error").map(finding =>
      ({ code: finding.code, path: finding.path }))).toEqual([{ code, path }]);
    const restored = check("offlineFixture");
    expect(restored.status, `${name}\n${restored.stdout}\n${restored.stderr}`).toBe(0);
    expectSatisfied(restored.stdout);
  }
});

function readRecipe(name: string) {
  const readme = readFileSync(join(example(name), "README.md"), "utf8");
  const binding = name.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  const filename = name === "pet-food" ? "petfood-pack.ts" : `${name}-pack.ts`;
  const target = `owned/${filename}`;
  const copy = `cp "$REFERENCE_PACK_DIR/pack.ts" ${target}`;
  const importEntry = `import { referenceEntry as ${binding} } from './${filename}';`;
  const append = `catalogueConformance.packs.push(${binding});`;
  for (const literal of [copy, target, "byte-for-byte identical", importEntry, ownedList, explicitList, append,
    sourceCheck, satisfied, ...excludedAdvisories, up, health, "`200`", "exit 0", "npm run catalogue:apply -- --json",
    "./lifecycle browser browser/catalogue-products.spec.ts"]) {
    expect(readme, name).toContain(literal);
  }
  return { copy, target, importEntry, append };
}

function materialize() {
  const archives = packageNames.map(name => {
    const packed = JSON.parse(executable("npm", ["pack", "--ignore-scripts", "--json",
      "--pack-destination", scratch], resolve("packages", name))) as { filename: string }[];
    return join(scratch, packed[0]!.filename);
  });
  executable(process.execPath, [join(source, "extract.mjs"), app], resolve("."));
  expect(executable("./lifecycle", ["candidate", ...archives], app)).toContain("next: npm ci");
  executable("npm", ["ci"], app);
  const locate = createRequire(join(app, "package.json"));
  for (const name of packageNames) {
    expect(locate.resolve(`@openlup/${name}/package.json`)).toBe(join(app, "node_modules", "@openlup", name, "package.json"));
  }
  const path = locate.resolve("@openlup/platform/catalog");
  expect(path.startsWith(join(app, "node_modules", "@openlup/platform") + sep)).toBe(true);
  return pathToFileURL(path).href;
}

// Only the installer image has the scratch database's Unix socket. Relay a
// test connection over Compose stdio without publishing a database port.
async function scratchDatabase() {
  const relay = `const socket = require("node:net").connect("/var/run/postgresql/.s.PGSQL.5432");
    process.stdin.pipe(socket); socket.pipe(process.stdout);
    socket.on("end", () => process.stdin.destroy());`;
  const server = createServer(socket => {
    const child = spawn("docker", ["compose", "run", "--rm", "--no-deps", "-T", "installation",
      "node", "-e", relay], { cwd: app, env: childEnv, stdio: ["pipe", "pipe", "inherit"] });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.once("error", error => socket.destroy(error));
    child.once("close", () => socket.destroy());
    child.stdin.on("error", () => socket.destroy());
    socket.once("close", () => child.stdin.end());
  });
  bridge = server;
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(join(temporary, ".s.PGSQL.5432"), done);
  });
}

function scratchPool(user: string) {
  const pool = new Pool({ host: temporary, port: 5432, database: "neutral_store",
    user, max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 30_000 });
  pools.push(pool);
  return pool;
}

async function tableRows(db: Pool, table: string) {
  return (await db.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`))
    .rows.map(({ row }) => row);
}

async function installedState(db: Pool) {
  return {
    receipts: await tableRows(db, "catalog_definition_installs"),
    types: await tableRows(db, "catalog_type_versions"),
    taxes: await tableRows(db, "catalog_tax_classes"),
  };
}

function assertInstalled(catalog: Catalog, rules: Buffer, input: CatalogPackInput, state: Awaited<ReturnType<typeof installedState>>) {
  const bound = catalog.withCatalogPublicationRules(input, () => rules);
  const manifest = catalog.catalogPackManifest(bound);
  const receipt = state.receipts.find(row => row.pack_id === input.id && row.pack_version === input.version);
  expect(receipt).toMatchObject({ manifest_digest: manifest.digest, receipt: {
    packId: input.id, packVersion: input.version, manifestDigest: manifest.digest, types: manifest.types,
  } });
  for (const type of bound.types) {
    const persisted = state.types.find(row => row.type_key === type.key && row.version === type.version);
    // The public digest hashes the same canonical bytes the installer stores.
    const expectedDigest = catalog.catalogDefinitionDigest(type);
    expect(persisted?.definition_digest).toBe(expectedDigest);
    expect(hash(catalog.canonicalCatalogDraftJson(persisted.definition))).toBe(expectedDigest);
  }
  for (const { key } of input.taxClasses) {
    expect(state.taxes).toContainEqual(expect.objectContaining({ key, status: "active" }));
  }
}

async function installRecipes() {
  const recipes = cases.map(({ name }) => ({ name, ...readRecipe(name) }));
  const catalog = await import(/* @vite-ignore */ materialize()) as Catalog;
  const managedBytes = new Map(managed.map(path => [path, readFileSync(join(app, path))]));
  const declaration = join(app, "owned/catalogue.ts");
  const rules = readFileSync(join(app, "owned/catalogue-rules.cjs"));
  const entries = new Map<string, Entry>();
  let previous: Awaited<ReturnType<typeof installedState>> | undefined;
  let db: Pool | undefined;
  for (const { name, copy, target, importEntry, append } of recipes) {
    recipe(copy, { REFERENCE_PACK_DIR: example(name) });
    const copied = join(app, target);
    expect(readFileSync(copied)).toEqual(readFileSync(join(example(name), "pack.ts")));
    const owned = readFileSync(declaration, "utf8");
    expect(owned).toContain(entries.size === 0 ? ownedList : explicitList);
    writeFileSync(declaration, importEntry + "\n" + owned.replace(ownedList, explicitList) + append + "\n");
    expectSatisfied(recipe(sourceCheck), true);

    const { referenceEntry } = await import(/* @vite-ignore */ pathToFileURL(copied).href) as { referenceEntry: Entry };
    expect(Object.keys(referenceEntry).sort()).toEqual(["drafts", "pack"]);
    entries.set(name, referenceEntry);

    composeUsed = true;
    recipe(up);
    expect(recipe(health).trim()).toBe("200");
    if (!db) {
      await scratchDatabase();
      db = scratchPool("starter_install");
    }
    const current = await installedState(db);
    if (previous) {
      for (const table of ["receipts", "types", "taxes"] as const) {
        expect(current[table]).toEqual(expect.arrayContaining(previous[table]));
      }
    }
    expect(current.receipts).toHaveLength(entries.size + 1);
    for (const entry of entries.values()) assertInstalled(catalog, rules, entry.pack, current);
    previous = current;
    for (const [path, bytes] of managedBytes) expect(readFileSync(join(app, path)), path).toEqual(bytes);
    expect(readFileSync(join(app, "owned/catalogue-rules.cjs"))).toEqual(rules);
  }
  if (!db) throw new Error("No reference packs installed");
  return { catalog, db, entries };
}

function installedRecipes() {
  return installation ??= installRecipes();
}

it("reference_pack_readmes_install_on_one_starter", async () => {
  await installedRecipes();
}, recipeTimeout);

function publicationDraft(catalog: Catalog, fixture: CatalogDraftPayloadV3, slug: string) {
  // Give the offline fixture a document and a full create plan for the owned rules.
  const payload = structuredClone(fixture);
  const productId = randomUUID(), draftId = randomUUID(), revisionId = randomUUID();
  const schemaId = "example:document.v1", documentRef = `example:${slug}`, sourceRef = "example:reference-pack";
  const name = String(fixture.product.sharedContent.presentation.title);
  const document = { schemaId, documentRef, productSlug: slug, revisionNo: 1, name };
  const canonicalText = catalog.canonicalCatalogDraftJson(document), digest = hash(canonicalText);
  const skus = payload.skus.map((sku, index) => ({
    ...sku, id: randomUUID(), productId, code: `${slug.toUpperCase()}-${index + 1}`,
  }));
  payload.skus = skus;
  Object.assign(payload.product, { id: productId, slug, primarySkuId: skus[0]!.id,
    documentRevision: { id: revisionId, productId, revisionNo: 1, schemaId, sourceRef, documentRef, digest } });
  const shared = payload.product.sharedContent;
  shared.document = document;
  shared.publicationSkus = skus.map(sku => ({
    skuCode: sku.code, title: name, minQuantity: 1, isAddon: false, facts: {},
  }));
  shared.requestedModes = skus.map(sku => ({ skuCode: sku.code, modes: [] }));
  payload.publication.operations = [
    { op: "create_product", productId, productSlug: slug, name },
    { op: "register_document_revision", productSlug: slug, revisionId, revisionNo: 1, documentRef,
      sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
    ...skus.flatMap((sku, index): CatalogDraftPayloadV3["publication"]["operations"] => [
      { op: "create_sku", productSlug: slug, documentRevisionNo: 1, skuId: sku.id, ...shared.publicationSkus[index]! },
      { op: "create_identifier", skuCode: sku.code, ...sku.identifiers![0]!,
        quantity: 1, isPrimary: true, label: null, sourceRef: null },
    ]),
    { op: "set_primary_sku", productSlug: slug, skuCode: skus[0]!.code },
    { op: "set_product_presentation", productSlug: slug, presentation: shared.presentation },
  ];
  return { payload, draftId, productId };
}

async function publicationEffects(db: Pool) {
  const tables = ["catalog_operator_receipts", "catalog_publication_decisions", "catalog_publications",
    "catalog_publication_heads", "catalog_products", "catalog_product_document_revisions", "catalog_skus",
    "catalog_sku_revisions", "catalog_sku_identifiers", "catalog_attribute_projection", "price_entries", "outbox_events"];
  const results: Awaited<ReturnType<typeof tableRows>>[] = [];
  for (const table of tables) results.push(await tableRows(db, table));
  return results;
}

function replaceUnitGtin(draft: CatalogDraftPayloadV3, index: number, value: string) {
  const sku = draft.skus[index]!;
  sku.identifiers![0]!.value = value;
  const operation = draft.publication.operations.find(op => op.op === "create_identifier" && op.skuCode === sku.code);
  if (operation?.op !== "create_identifier") throw new Error("Fixture identifier operation missing");
  operation.value = value;
}

it("reference_pack_native_refusals", async () => {
  const { catalog, db, entries } = await installedRecipes();
  const actor = randomUUID();
  await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",
    [actor, "reference-pack-operator@example.invalid"]);
  await db.query(`INSERT INTO public.platform_human_memberships
    (principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',clock_timestamp())`, [actor]);
  const rules = readFileSync(join(app, "owned/catalogue-rules.cjs"));
  const registry = catalog.createCatalogProductTypeRegistry([...entries.values()].flatMap(({ pack }) =>
    catalog.withCatalogPublicationRules(pack, () => rules).types));
  const publicationDb = scratchPool("openlup_catalog_publication");
  const publisher = catalog.createPostgresCatalogPublicationCommands({
    registry,
    authorizeHuman: async (userId: string) => ({ ok: true, userId, role: "admin", isMachineActor: false }),
    catalogPublicationOwner: { run: work => transaction(publicationDb, work) },
  });
  const who = await publisher.authorize(actor);
  if (!who) throw new Error("Scratch publisher authorization refused");
  const store = catalog.createPostgresCatalogDraftStoreV3(scratchPool("starter_runtime"));
  async function saveAndPrepare(draft: ReturnType<typeof publicationDraft>, revision: number) {
    const canonicalCommand = catalog.canonicalCatalogDraftJson({ schemaVersion: 3,
      action: revision === 1 ? "create" : "revise", draftId: draft.draftId,
      commandKey: randomUUID(), expectedRevision: revision - 1, payload: draft.payload });
    expect(await store.apply({ canonicalCommand, fingerprint: hash(canonicalCommand), actorId: actor }))
      .toMatchObject({ outcome: "committed", record: { revision } });
    const candidate = await publisher.prepareCandidate({ draftId: draft.draftId, draftRevision: revision, expectedHead: null }, who!);
    if (!("candidateRef" in candidate) || !candidate.preparation?.postStateDigest)
      throw new Error(`Draft could not prepare: ${JSON.stringify(candidate)}`);
    const common = { productId: draft.productId, candidateRef: candidate.candidateRef, candidateDigest: candidate.candidateDigest };
    return {
      approve: { ...common, action: "approve", reason: null, commandKey: randomUUID(),
        postStateDigest: candidate.preparation.postStateDigest },
      publish: { ...common, action: "publish", expectedHead: null, changes: [], commandKey: randomUUID() },
    } satisfies Record<string, CatalogPublicationCommand>;
  }
  const execute = (command: CatalogPublicationCommand) => publisher.execute(command, who);

  const supplements = publicationDraft(catalog, entries.get("supplements")!.drafts[0]!, "reference-capsules");
  const supplementCommands = await saveAndPrepare(supplements, 1);
  try {
    expect((await db.query("UPDATE public.catalog_tax_classes SET status='retired' WHERE key='reduced'")).rowCount).toBe(1);
    const before = await publicationEffects(db);
    expect(await execute(supplementCommands.approve))
      .toMatchObject({ outcome: "validation_issue", reason: "publication_tax_class_unavailable" });
    expect(await publicationEffects(db)).toEqual(before);
  } finally {
    await db.query("UPDATE public.catalog_tax_classes SET status='active' WHERE key='reduced'");
  }
  expect(await execute(supplementCommands.approve)).toMatchObject({ outcome: "committed" });

  const petFood = entries.get("pet-food")!.drafts[0]!;
  const first = publicationDraft(catalog, petFood, "reference-wet-first");
  const firstCommands = await saveAndPrepare(first, 1);
  expect(await execute(firstCommands.approve)).toMatchObject({ outcome: "committed" });
  expect(await execute(firstCommands.publish)).toMatchObject({ outcome: "committed" });

  const second = publicationDraft(catalog, petFood, "reference-wet-second");
  const duplicate = first.payload.skus[0]!.identifiers![0]!.value;
  expect((await db.query(`SELECT normalized_value, pack_kind FROM public.catalog_sku_identifiers
    WHERE catalog_sku_id=$1`, [first.payload.skus[0]!.id])).rows)
    .toEqual([{ normalized_value: duplicate.padStart(14, "0"), pack_kind: "unit" }]);
  const replacement = catalog.catalogInternalGtin(803);
  replaceUnitGtin(second.payload, 0, duplicate);
  replaceUnitGtin(second.payload, 1, catalog.catalogInternalGtin(804));
  const secondCommands = await saveAndPrepare(second, 1);
  expect(await execute(secondCommands.approve)).toMatchObject({ outcome: "committed" });
  const before = await publicationEffects(db);
  expect(await execute(secondCommands.publish)).toMatchObject({ outcome: "conflict", reason: "publication_gtin_conflict" });
  expect(await publicationEffects(db)).toEqual(before);

  replaceUnitGtin(second.payload, 0, replacement);
  const recovered = await saveAndPrepare(second, 2);
  expect(await execute(recovered.approve)).toMatchObject({ outcome: "committed" });
  expect(await execute(recovered.publish)).toMatchObject({ outcome: "committed" });
}, recipeTimeout);
