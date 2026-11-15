import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { catalogDefinitionDigest, catalogPackManifest, canonicalCatalogDraftJson, createCatalogDefinitionWriteGuard,
  createCatalogProductTypeRegistry, createPostgresCatalogDraftStore, installCatalogDefinitions, observeCatalogDefinitionReadiness } from "@openlup/platform/catalog";
import type { CatalogPackInput } from "@openlup/platform/catalog/contracts";
import { verifyApp } from "@openlup/platform/lifecycle";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const path = "db/platform/migrations/20261122100000_catalog_definition_binding.sql";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let owner: Pool, runtime: Pool, product: string, baseline: unknown;
const definition = (version = 1) => ({ key: "example:item", version,
  units: [{ code: "openlup:piece", dimension: "count" as const, integral: true }], netContentUnits: ["openlup:piece"],
  dimensions: [], validatorRef: `sha256:${String(version).repeat(64)}`, validateContent: () => [] });
const pack = (id: string, version = 1): CatalogPackInput => ({ id: `example:${id}`, namespace: "example", version,
  openlupRange: "0.44.x", capabilities: { publish: false }, types: [definition(version)], taxClasses: [{ key: "example:standard" }] });
const snapshot = async () => (await owner.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(p)-'type_key'-'type_version' ORDER BY id) FROM public.catalog_products p) AS products,
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.catalog_skus s) AS skus,
  (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.catalog_product_document_revisions d) AS documents,
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.price_entries e) AS prices,
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.subscriptions s) AS subscriptions,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.subscription_lines l) AS lines`)).rows;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Catalogue definition witnesses require real PostgreSQL");
  const container = await runPostgresContainer({ name: `catalog-definitions-${process.pid}`, password: "synthetic-catalogue" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue PostgreSQL unavailable");
  const bootstrap = new Pool({ connectionString: container.connectionString }); pools.push(bootstrap);
  await bootstrap.query("CREATE ROLE catalog_install LOGIN SUPERUSER PASSWORD 'synthetic-catalogue'; CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS; ALTER DATABASE postgres OWNER TO catalog_install");
  const installUrl = new URL(container.connectionString); installUrl.username = "catalog_install";
  owner = new Pool({ connectionString: installUrl.toString() }); pools.push(owner);
  // Apply the unchanged native prefix first; legacy facts exist before the new forward.
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === path) break;
    await owner.query(readFileSync(unit.file, "utf8"));
  }
  product = (await owner.query("INSERT INTO public.catalog_products(slug,name) VALUES ('legacy-item','Legacy item') RETURNING id")).rows[0].id;
  const sku = (await owner.query("INSERT INTO public.catalog_skus(product_id,sku,title,net_weight_g) VALUES ($1,'LEGACY-ITEM','Legacy unit',100) RETURNING id", [product])).rows[0].id;
  const document = (await owner.query(`INSERT INTO public.catalog_product_document_revisions
    (product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest)
    VALUES($1,1,'example:v1','document:legacy','{}','source:legacy','{}',$2) RETURNING id`, [product, "a".repeat(64)])).rows[0].id;
  await owner.query("UPDATE public.catalog_products SET primary_sku_id=$2,current_document_revision_id=$3 WHERE id=$1", [product, sku, document]);
  const list = (await owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES ('Example','ZZ','XXX') RETURNING id")).rows[0].id;
  await owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,123)", [list, sku]);
  const client = (await owner.query("INSERT INTO public.clients(email) VALUES ('synthetic@example.invalid') RETURNING id")).rows[0].id;
  const subscription = (await owner.query("INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at) VALUES($1,28,clock_timestamp()+interval '28 days') RETURNING id", [client])).rows[0].id;
  await owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code)
    VALUES($1,$2,2,0,123,'XXX')`, [subscription, sku]);
  baseline = await snapshot();
  await owner.query(readFileSync(path, "utf8"));
  expect(await snapshot()).toEqual(baseline);
  await owner.query("CREATE ROLE catalog_runtime LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-catalogue'");
  await owner.query("GRANT service_role TO catalog_runtime WITH INHERIT TRUE, SET TRUE");
  await owner.query("GRANT SELECT ON public.catalog_products TO catalog_runtime; GRANT UPDATE(name) ON public.catalog_products TO catalog_runtime");
  const url = new URL(container.connectionString); url.username = "catalog_runtime";
  runtime = new Pool({ connectionString: url.toString() }); pools.push(runtime);
  // The immutable legacy prefix needs bootstrap privileges; feature calls need only ownership.
  await bootstrap.query("ALTER ROLE catalog_install NOSUPERUSER NOBYPASSRLS");
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

it("catalog_legacy_backfill_preserves_references", async () => {
  await installCatalogDefinitions(owner, pack("legacy"));
  expect(await snapshot()).toEqual(baseline);
  expect((await owner.query("SELECT type_key,type_version FROM public.catalog_products WHERE id=$1", [product])).rows)
    .toEqual([{ type_key: null, type_version: null }]);
});

it("pack_install_is_idempotent_and_install_role_only", async () => {
  expect((await owner.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ rolsuper: false, rolbypassrls: false }]);
  expect((await runtime.query("SELECT pg_has_role(current_user, 'catalog_install', 'MEMBER') AS owner_member, pg_has_role(current_user, 'service_role', 'USAGE') AS runtime_group")).rows)
    .toEqual([{ owner_member: false, runtime_group: true }]);
  const input = pack("idempotent");
  const receipts = await Promise.all([installCatalogDefinitions(owner, input), installCatalogDefinitions(owner, input)]);
  expect(receipts[1]).toEqual(receipts[0]);
  expect(receipts[0].manifestDigest).toBe(catalogPackManifest(input).digest);
  expect((await runtime.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ current_user: "catalog_runtime", rolsuper: false, rolbypassrls: false }]);
  expect((await owner.query(`SELECT p.proowner=current_user::regrole AS owned, p.prosecdef,
    has_function_privilege('catalog_runtime',p.oid,'EXECUTE') AS runtime_execute
    FROM pg_proc p WHERE p.oid='public.catalog_definition_install(text,integer,jsonb)'::regprocedure`)).rows)
    .toEqual([{ owned: true, prosecdef: false, runtime_execute: false }]);
  await expect(installCatalogDefinitions(runtime, input)).rejects.toMatchObject({ code: "42501" });
  await expect(installCatalogDefinitions(owner, { ...input, capabilities: { publish: true } })).rejects.toMatchObject({ code: "23505" });
  await owner.query("UPDATE public.catalog_tax_classes SET status='retired' WHERE key='example:standard'");
  await installCatalogDefinitions(owner, pack("retired"));
  expect((await owner.query("SELECT status FROM public.catalog_tax_classes WHERE key='example:standard'")).rows).toEqual([{ status: "retired" }]);
});

it("definition installation uses shared pack closure before SQL", async () => {
  const before = (await owner.query("SELECT count(*)::int AS count FROM public.catalog_definition_installs")).rows;
  const unknownField = { ...pack("unknown-field"), unexpected: true };
  const unknownTaxClass = { ...pack("unknown-tax-class"), types: [{ ...definition(), taxClass: "example:missing" }] };
  const unknownProfile = { ...pack("unknown-profile"), types: [{ ...definition(), subscriptionProfileRef: { key: "example:missing", version: 1 } }] };
  for (const [input, code] of [[unknownField, "definition_unknown_field"], [unknownTaxClass, "definition_unknown_tax_class"],
    [unknownProfile, "definition_unknown_profile_ref"]] as const) {
    await expect(installCatalogDefinitions(owner, input)).rejects.toMatchObject({ message: "invalid_catalog_pack", issue: { code } });
  }
  expect((await owner.query("SELECT count(*)::int AS count FROM public.catalog_definition_installs")).rows).toEqual(before);
});

it("pack_custom_unit_needs_no_ddl", async () => {
  const ddl = async () => (await owner.query("SELECT oid,relname,relkind FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid")).rows;
  const before = await ddl();
  const input = pack("custom"); input.types = [{ ...definition(), key: "example:custom", units: [{ code: "example:pair", dimension: "count", integral: true,
    factor: { canonicalUnit: "openlup:piece", unscaled: "2", scale: 0 } }], netContentUnits: ["example:pair"] }];
  await installCatalogDefinitions(owner, input);
  expect(await ddl()).toEqual(before);
  expect((await owner.query("SELECT definition->'units' AS units FROM public.catalog_type_versions WHERE type_key='example:custom'")).rows[0].units)
    .toEqual(input.types[0].units);
});

it("pack_install_never_publishes", async () => {
  const before = await snapshot();
  await installCatalogDefinitions(owner, pack("unpublished"));
  expect(await snapshot()).toEqual(before);
});

it("catalog_type_install_refuses_redefinition", async () => {
  const input = pack("immutable"); await installCatalogDefinitions(owner, input);
  for (const changed of [{ ...definition(), validatorRef: `sha256:${"f".repeat(64)}` }, { ...definition(), dimensions: [{ key: "flag", kind: "boolean" as const }] }]) {
    await expect(installCatalogDefinitions(owner, { ...input, id: `example:changed-${randomUUID()}`, types: [changed] })).rejects.toMatchObject({ code: "23505" });
  }
  await expect(owner.query("UPDATE public.catalog_type_versions SET validator_ref='changed' WHERE type_key='example:item' AND version=1")).rejects.toMatchObject({ code: "55000" });
  await expect(owner.query("DELETE FROM public.catalog_type_versions WHERE type_key='example:item' AND version=1")).rejects.toMatchObject({ code: "55000" });
  expect((await owner.query("SELECT definition_digest FROM public.catalog_type_versions WHERE type_key='example:item' AND version=1")).rows[0].definition_digest)
    .toBe(catalogDefinitionDigest(definition()));
});

it("live type binding requires an installed complete reference and a SKU inherits it", async () => {
  await expect(owner.query("UPDATE public.catalog_products SET type_key='example:item' WHERE id=$1", [product])).rejects.toMatchObject({ code: "23514" });
  await expect(owner.query("UPDATE public.catalog_products SET type_key='example:absent',type_version=1 WHERE id=$1", [product])).rejects.toMatchObject({ code: "23503" });
  await owner.query("UPDATE public.catalog_products SET type_key='example:item',type_version=1 WHERE id=$1", [product]);
  expect((await owner.query("SELECT p.type_key,p.type_version FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id")).rows)
    .toEqual([{ type_key: "example:item", type_version: 1 }]);
  await owner.query("UPDATE public.catalog_products SET type_key=NULL,type_version=NULL WHERE id=$1", [product]);
});

it("runtime_refuses_registry_missing_referenced_version", async () => {
  await owner.query("UPDATE public.catalog_products SET type_key='example:item',type_version=1 WHERE id=$1", [product]);
  const before = await snapshot();
  for (const definitions of [[], [{ ...definition(), validatorRef: `sha256:${"e".repeat(64)}` }]]) {
    const registry = createCatalogProductTypeRegistry(definitions);
    const guard = createCatalogDefinitionWriteGuard(owner, registry);
    await expect(guard(() => runtime.query("UPDATE public.catalog_products SET name='Changed' WHERE id=$1", [product])))
      .rejects.toThrow("registry_missing_referenced_version");
    expect(await snapshot()).toEqual(before);
    const catalogRegistry = await observeCatalogDefinitionReadiness(owner, registry, "catalog-db");
    const report = await verifyApp({ candidate: { artifact: "test", configuration: "test", environment: "test", database: "catalog-db", schema: "test" },
      inventoryComplete: true, loadedPackages: [{ name: "@openlup/core", version: "0.43.0", kind: "kernel" }], contributions: [], vocabulary: [], exemptions: [],
      bindings: { ports: {}, routes: {}, triggers: {}, env: {} }, schemaProbe: { observe: async () => { throw new Error("not required"); } }, catalogRegistry });
    expect(report.state).toBe("unsatisfied");
    expect(report.findings.map(finding => finding.code)).toEqual(["registry_missing_referenced_version"]);
  }
  const guard = createCatalogDefinitionWriteGuard(owner, createCatalogProductTypeRegistry([definition()]));
  expect((await guard(() => runtime.query("UPDATE public.catalog_products SET name=name WHERE id=$1", [product]))).rowCount).toBe(1);
  await owner.query("UPDATE public.catalog_products SET type_key=NULL,type_version=NULL WHERE id=$1", [product]);
});

it("catalog_v1_receipt_replays_after_type_upgrade", async () => {
  const productId = randomUUID();
  const command = canonicalCatalogDraftJson({ schemaVersion: 1, action: "create", draftId: randomUUID(), commandKey: "create-v1", expectedRevision: 0,
    payload: { schemaVersion: 1, product: { id: productId, type: { key: "example:item", version: 1 }, dimensions: [] }, skus: [] } });
  const request = { canonicalCommand: command, fingerprint: createHash("sha256").update(command).digest("hex"), actorId: "synthetic:operator" };
  const store = createPostgresCatalogDraftStore(owner);
  const receipt = await store.apply(request); expect(receipt.outcome).toBe("committed");
  await installCatalogDefinitions(owner, pack("type-upgrade", 2));
  expect(await store.apply(request)).toEqual({ ...receipt, outcome: "replayed" });
});
