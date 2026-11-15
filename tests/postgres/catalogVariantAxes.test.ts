import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalizeCatalogCombinationV2, classifyCatalogCombinationConflictV2, installCatalogDefinitions,
  type CatalogCombinationIdentityV2, type CatalogProductTypeInput } from "@openlup/platform/catalog";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const path = "db/platform/migrations/20261122130000_catalog_variant_axes.sql";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let owner: Pool;
let existingSecurity: unknown;
const definition: CatalogProductTypeInput = { key: "example:axes", version: 1,
  units: [{ code: "openlup:piece", dimension: "count", integral: true, factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } }],
  netContentUnits: ["openlup:piece"], dimensions: ["enabled", "visible"].map(key => ({ key, kind: "boolean" })),
  attributes: ["enabled", "visible"].map(key => ({ key, scope: "variant", valueType: { kind: "boolean" }, required: true, cardinality: { min: 1, max: 1 },
    filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} })),
  axes: ["enabled", "visible"].map(key => ({ key, attributeKey: key })), validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
const options = (enabled: boolean) => ({ enabled: { kind: "boolean" as const, value: enabled } });
const identity = (enabled: boolean) => canonicalizeCatalogCombinationV2({ definition, axes: ["enabled"], options: options(enabled) });
const security = (db: Pool) => db.query(`SELECT c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
  FROM pg_class c WHERE c.oid IN ('public.catalog_products'::regclass,'public.catalog_skus'::regclass) ORDER BY c.relname`);

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Catalogue axis witnesses require real PostgreSQL");
  const container = await runPostgresContainer({ name: `catalog-axes-${process.pid}`, password: "synthetic-catalogue" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue PostgreSQL unavailable");
  const bootstrap = new Pool({ connectionString: container.connectionString }); pools.push(bootstrap);
  await bootstrap.query("CREATE ROLE catalog_axes_install LOGIN SUPERUSER PASSWORD 'synthetic-catalogue'; CREATE ROLE service_role NOLOGIN; ALTER DATABASE postgres OWNER TO catalog_axes_install");
  const url = new URL(container.connectionString); url.username = "catalog_axes_install";
  owner = new Pool({ connectionString: url.toString() }); pools.push(owner);
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === path) break;
    await owner.query(readFileSync(unit.file, "utf8"));
  }
  const product = (await owner.query("INSERT INTO public.catalog_products(slug,name) VALUES('legacy-axes','Synthetic legacy') RETURNING id")).rows[0].id;
  await owner.query("INSERT INTO public.catalog_skus(product_id,sku,title) VALUES($1,'LEGACY-AXES-A','Synthetic'),($1,'LEGACY-AXES-B','Synthetic')", [product]);
  const before = (await owner.query("SELECT to_jsonb(p) AS product,to_jsonb(s) AS sku FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id ORDER BY s.sku")).rows;
  existingSecurity = (await security(owner)).rows;
  await owner.query(readFileSync(path, "utf8"));
  expect((await owner.query(`SELECT to_jsonb(p)-'variant_axes' AS product,
    to_jsonb(s)-ARRAY['option_values','canonical_option_bytes','combination_digest'] AS sku
    FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id ORDER BY s.sku`)).rows).toEqual(before);
  expect((await owner.query(`SELECT p.variant_axes,s.option_values,s.canonical_option_bytes,s.combination_digest
    FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id`)).rows)
    .toEqual(Array.from({ length: 2 }, () => ({ variant_axes: null, option_values: null, canonical_option_bytes: null, combination_digest: null })));
  await bootstrap.query("ALTER ROLE catalog_axes_install NOSUPERUSER NOBYPASSRLS");
  await installCatalogDefinitions(owner, { id: "example:axis-pack", namespace: "example", version: 1, openlupRange: "0.44.x",
    capabilities: { publish: false }, types: [definition], taxClasses: [] });
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

async function product(axes: string[] | null = ["enabled"]) {
  return (await owner.query(`INSERT INTO public.catalog_products(slug,name,type_key,type_version,variant_axes)
    VALUES($1,'Synthetic typed','example:axes',1,$2) RETURNING id`, [randomUUID(), axes])).rows[0].id as string;
}
async function sku(db: Pool | PoolClient, productId: string, evidence: CatalogCombinationIdentityV2 | null,
  state = "active", values: object | null = options(false), code: string = randomUUID()) {
  return (await db.query(`INSERT INTO public.catalog_skus(product_id,sku,title,status,option_values,canonical_option_bytes,combination_digest)
    VALUES($1,$2,'Synthetic SKU',$3,$4,$5,$6) RETURNING id`, [productId, code, state, values === null ? null : JSON.stringify(values),
    evidence?.canonicalOptionBytes ?? null, evidence?.combinationDigest ?? null])).rows[0].id as string;
}

it("catalog_live_axes_roundtrip_in_declared_order", async () => {
  const id = await product(["visible", "enabled"]), values = { ...options(false), visible: { kind: "boolean" as const, value: true } };
  const evidence = canonicalizeCatalogCombinationV2({ definition, axes: ["visible", "enabled"], options: values });
  const skuId = await sku(owner, id, evidence, "active", values);
  expect((await owner.query(`SELECT p.variant_axes,s.option_values,s.canonical_option_bytes,s.combination_digest
    FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id WHERE s.id=$1`, [skuId])).rows)
    .toEqual([{ variant_axes: ["visible", "enabled"], option_values: values, canonical_option_bytes: evidence.canonicalOptionBytes,
      combination_digest: evidence.combinationDigest }]);
});

it("catalog_no_axes_allows_one_typed_active_sku", async () => {
  const id = await product([]), empty = canonicalizeCatalogCombinationV2({ definition, axes: [], options: {} });
  await sku(owner, id, empty, "active", {});
  await expect(sku(owner, id, empty, "active", {})).rejects.toMatchObject({ code: "23505", constraint: "catalog_skus_active_combination_idx" });
  await sku(owner, await product([]), empty, "active", {});
});

it("catalog_restore_refuses_occupied_combination", async () => {
  const id = await product(), evidence = identity(false);
  const withdrawn = await sku(owner, id, evidence, "archived"), active = await sku(owner, id, evidence);
  const before = (await owner.query("SELECT to_jsonb(s) AS row FROM public.catalog_skus s WHERE product_id=$1 ORDER BY id", [id])).rows;
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE public.catalog_products SET name='must roll back' WHERE id=$1", [id]);
    await expect(db.query("UPDATE public.catalog_skus SET status='active' WHERE id=$1", [withdrawn]))
      .rejects.toMatchObject({ code: "23505", constraint: "catalog_skus_active_combination_idx" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect((await owner.query("SELECT to_jsonb(s) AS row FROM public.catalog_skus s WHERE product_id=$1 ORDER BY id", [id])).rows).toEqual(before);
  expect((await owner.query("SELECT name FROM public.catalog_products WHERE id=$1", [id])).rows[0].name).toBe("Synthetic typed");
  expect(withdrawn).not.toBe(active);
});

it("catalog_digest_collision_never_merges_skus", async () => {
  const id = await product(), a = identity(false), b = { ...identity(true), combinationDigest: a.combinationDigest };
  // Only this test injects a colliding digest; production preparation accepts options, never a digest.
  expect(classifyCatalogCombinationConflictV2(a, b)).toBe("collision");
  const first = await sku(owner, id, a), db = await owner.connect();
  try {
    await db.query("BEGIN");
    await sku(db, id, null, "draft", null);
    await expect(sku(db, id, b, "active", options(true))).rejects.toMatchObject({ code: "23505" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect((await owner.query("SELECT id,option_values,canonical_option_bytes FROM public.catalog_skus WHERE product_id=$1", [id])).rows)
    .toEqual([{ id: first, option_values: options(false), canonical_option_bytes: a.canonicalOptionBytes }]);
});

it("catalog_publish_refuses_duplicate_combination", async () => {
  // Preparatory SQL substrate only: LC2 still owes the actual publish API transaction witness.
  const id = await product(), a = await owner.connect(), b = await owner.connect(), evidence = identity(false);
  try {
    expect((await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid).not.toBe((await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const attempts = [a, b].map(async db => {
      await db.query("BEGIN");
      try {
        await sku(db, id, null, "draft", null);
        const result = await sku(db, id, evidence);
        await db.query("COMMIT");
        return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
    });
    const results = await Promise.allSettled(attempts);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").map(result => result.reason))
      .toEqual([expect.objectContaining({ code: "23505", constraint: "catalog_skus_active_combination_idx" })]);
    expect((await owner.query("SELECT status,count(*)::int AS count FROM public.catalog_skus WHERE product_id=$1 GROUP BY status ORDER BY status", [id])).rows)
      .toEqual([{ status: "active", count: 1 }, { status: "draft", count: 1 }]);
  } finally { a.release(); b.release(); }
});

it("catalog_combination_checks_and_sku_local_predicate", async () => {
  const id = await product(), evidence = identity(false);
  for (const value of [[], "text", true, 1]) await expect(sku(owner, id, null, "draft", value as object)).rejects.toMatchObject({ code: "23514", constraint: "catalog_skus_option_values_check" });
  await expect(owner.query("INSERT INTO public.catalog_skus(product_id,sku,title,option_values) VALUES($1,$2,'Synthetic','null'::jsonb)", [id, randomUUID()]))
    .rejects.toMatchObject({ code: "23514" });
  for (const width of [0, 31, 33]) await expect(sku(owner, id, { ...evidence, combinationDigest: Buffer.alloc(width) }))
    .rejects.toMatchObject({ code: "23514", constraint: "catalog_skus_combination_digest_check" });
  for (const state of ["draft", "archived"]) { await sku(owner, id, evidence, state); await sku(owner, id, evidence, state); }
  await sku(owner, id, null, "active", null); await sku(owner, id, null, "active", null);
  await owner.query("UPDATE public.catalog_products SET status='archived' WHERE id=$1", [id]);
  await sku(owner, id, evidence);
  await expect(sku(owner, id, evidence)).rejects.toMatchObject({ code: "23505" });
  expect((await owner.query("SELECT convalidated FROM pg_constraint WHERE conname IN ('catalog_skus_option_values_check','catalog_skus_combination_digest_check')")).rows)
    .toEqual([{ convalidated: true }, { convalidated: true }]);
});

it("catalog_axis_forward_preserves_ownership_rls_acl_and_legacy_constraints", async () => {
  expect((await security(owner)).rows).toEqual(existingSecurity);
  expect((await owner.query(`SELECT c.relowner=current_user::regrole AS owned FROM pg_class c
    WHERE c.oid='public.catalog_skus_active_combination_idx'::regclass`)).rows).toEqual([{ owned: true }]);
  expect((await owner.query(`SELECT attname,attacl FROM pg_attribute WHERE attrelid IN ('public.catalog_skus'::regclass,'public.catalog_products'::regclass)
    AND attname IN ('variant_axes','option_values','canonical_option_bytes','combination_digest') ORDER BY attname`)).rows)
    .toEqual(["canonical_option_bytes", "combination_digest", "option_values", "variant_axes"].map(attname => ({ attname, attacl: null })));
  const id = await product(), first = await sku(owner, id, null, "draft", null, "UNIQUE-AXIS-CODE");
  await expect(sku(owner, await product(), null, "draft", null, "UNIQUE-AXIS-CODE")).rejects.toMatchObject({ code: "23505", constraint: "idx_catalog_skus_sku" });
  await expect(sku(owner, randomUUID(), null)).rejects.toMatchObject({ code: "23503" });
  expect((await owner.query("SELECT product_id FROM public.catalog_skus WHERE id=$1", [first])).rows).toEqual([{ product_id: id }]);
});
