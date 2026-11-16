import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateCatalogAttributes, prepareCatalogAttributeProjection, type CatalogProductTypeInput } from "@openlup/platform/catalog";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const path = "db/platform/migrations/20261122120000_catalog_attributes.sql";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let catalogue: Pool, attributeSku: string;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Catalogue attribute witnesses require real PostgreSQL");
  const container = await runPostgresContainer({ name: `catalog-attributes-${process.pid}`, password: "synthetic-catalogue" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue PostgreSQL unavailable");
  const bootstrap = new Pool({ connectionString: container.connectionString }); pools.push(bootstrap);
  await bootstrap.query("CREATE ROLE catalog_attribute_install LOGIN SUPERUSER PASSWORD 'synthetic-catalogue'; CREATE ROLE service_role NOLOGIN; ALTER DATABASE postgres OWNER TO catalog_attribute_install");
  const url = new URL(container.connectionString); url.username = "catalog_attribute_install";
  catalogue = new Pool({ connectionString: url.toString() }); pools.push(catalogue);
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === path) break;
    await catalogue.query(readFileSync(unit.file, "utf8"));
  }
  attributeSku = (await catalogue.query(`WITH product AS (
    INSERT INTO public.catalog_products(slug,name) VALUES('attribute-item','Synthetic attribute item') RETURNING id)
    INSERT INTO public.catalog_skus(product_id,sku,title) SELECT id,'ATTRIBUTE-ITEM','Synthetic attribute SKU' FROM product RETURNING id`)).rows[0].id;
  const before = (await catalogue.query(`SELECT to_jsonb(p) AS product,to_jsonb(s) AS sku
    FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id`)).rows;
  await catalogue.query(readFileSync(path, "utf8"));
  expect((await catalogue.query(`SELECT to_jsonb(p)-'attribute_values' AS product,to_jsonb(s)-'attribute_values' AS sku
    FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id`)).rows).toEqual(before);
  await bootstrap.query("ALTER ROLE catalog_attribute_install NOSUPERUSER NOBYPASSRLS");
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

it.each(["catalog_products", "catalog_skus"])("catalog_attribute_values_nullable_and_bounded: %s", async table => {
  expect((await catalogue.query(`SELECT attribute_values FROM public.${table}`)).rows).toEqual([{ attribute_values: null }]);
  for (const value of ["{}", '{"example:enabled":false,"example:list":[],"example:decimal":"-12345678901234567890.123456789012"}']) {
    await catalogue.query(`UPDATE public.${table} SET attribute_values=$1::jsonb`, [value]);
    expect((await catalogue.query(`SELECT attribute_values=$1::jsonb AS exact FROM public.${table}`, [value])).rows).toEqual([{ exact: true }]);
  }
  // PostgreSQL's rendered JSON text, including spaces and UTF-8, owns this ceiling.
  await catalogue.query(`UPDATE public.${table} SET attribute_values=jsonb_build_object('v',repeat('x',1048567))`);
  expect((await catalogue.query(`SELECT octet_length(CAST(attribute_values AS text)) AS bytes FROM public.${table}`)).rows).toEqual([{ bytes: 1048576 }]);
  for (const value of ['[]', '"text"', 'true', '1', 'null']) {
    await expect(catalogue.query(`UPDATE public.${table} SET attribute_values=$1::jsonb`, [value]))
      .rejects.toMatchObject({ code: "23514", constraint: `${table}_attribute_values_check` });
  }
  await expect(catalogue.query(`UPDATE public.${table} SET attribute_values=jsonb_build_object('v',repeat('x',1048568))`))
    .rejects.toMatchObject({ code: "23514", constraint: `${table}_attribute_values_check` });
  await expect(catalogue.query(`UPDATE public.${table} SET attribute_values=jsonb_build_object('v',repeat('é',524284))`))
    .rejects.toMatchObject({ code: "23514", constraint: `${table}_attribute_values_check` });
  await catalogue.query(`UPDATE public.${table} SET attribute_values=NULL`);
  expect((await catalogue.query(`SELECT convalidated FROM pg_constraint WHERE conname=$1`, [`${table}_attribute_values_check`])).rows)
    .toEqual([{ convalidated: true }]);
});

it("catalog_attribute_projection_owner_rls_acl", async () => {
  expect((await catalogue.query(`SELECT c.relowner=current_user::regrole AS owned,c.relrowsecurity,c.relforcerowsecurity,
    (SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policies,
    (SELECT count(*)::int FROM pg_attribute WHERE attrelid=c.oid AND attacl IS NOT NULL) AS column_acls
    FROM pg_class c WHERE c.oid='public.catalog_attribute_projection'::regclass`)).rows)
    .toEqual([{ owned: true, relrowsecurity: true, relforcerowsecurity: false, policies: 0, column_acls: 0 }]);
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await catalogue.query(`SELECT has_table_privilege($1,'public.catalog_attribute_projection','SELECT') AS read,
      has_table_privilege($1,'public.catalog_attribute_projection','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS write`, [role])).rows)
      .toEqual([{ read: false, write: false }]);
    const db = await pools[0]!.connect();
    try {
      await db.query("BEGIN");
      await db.query(`SET LOCAL ROLE ${role}`);
      expect((await db.query("SELECT row_security_active('public.catalog_attribute_projection') AS active")).rows).toEqual([{ active: true }]);
      await expect(db.query("SELECT * FROM public.catalog_attribute_projection")).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("ROLLBACK"); db.release(); }
  }
});

it("catalog_attribute_projection_revision_definition_ordinal_and_fk", async () => {
  const db = await catalogue.connect();
  try {
    await db.query("BEGIN");
    for (const [revision, version, ordinal] of [[1, 1, 0], [2, 1, 0], [1, 2, 0], [1, 1, 1]]) {
      await db.query(`INSERT INTO public.catalog_attribute_projection
        (sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind,numeric_value,canonical_value)
        VALUES($1,$2,'example:amount',$3,$4,'decimal',-123456789012345678901234567890.123456789012,-9999999999999999999999999999999999999999.999999999999)`,
      [attributeSku, revision, version, ordinal]);
    }
    expect((await db.query(`SELECT numeric_value::text,canonical_value::text FROM public.catalog_attribute_projection`)).rows)
      .toEqual(Array.from({ length: 4 }, () => ({ numeric_value: "-123456789012345678901234567890.123456789012", canonical_value: "-9999999999999999999999999999999999999999.999999999999" })));
    await db.query("SAVEPOINT refusal");
    await expect(db.query(`INSERT INTO public.catalog_attribute_projection(sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind)
      VALUES($1,1,'example:amount',1,0,'decimal')`, [attributeSku])).rejects.toMatchObject({ code: "23505" });
    await db.query("ROLLBACK TO SAVEPOINT refusal");
    await expect(db.query(`INSERT INTO public.catalog_attribute_projection(sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind)
      VALUES('00000000-0000-4000-8000-000000000000',1,'example:amount',1,0,'decimal')`)).rejects.toMatchObject({ code: "23503" });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("catalog_attribute_updates_coexist_with_referenced_key_share", async () => {
  const commerce = await catalogue.connect(), writer = await catalogue.connect();
  try {
    await commerce.query("BEGIN");
    await commerce.query("SELECT id FROM public.catalog_products ORDER BY id FOR KEY SHARE");
    await commerce.query("SELECT id FROM public.catalog_skus ORDER BY id FOR KEY SHARE");
    await writer.query("BEGIN");
    await writer.query(`UPDATE public.catalog_products SET attribute_values='{}'::jsonb`);
    await writer.query(`UPDATE public.catalog_skus SET attribute_values='{}'::jsonb`);
  } finally {
    await writer.query("ROLLBACK"); await commerce.query("ROLLBACK");
    writer.release(); commerce.release();
  }
});

it("catalog_attribute_projection_text_index_bound", async () => {
  const db = await catalogue.connect();
  try {
    await db.query("BEGIN");
    expect((await db.query("SHOW block_size")).rows).toEqual([{ block_size: "8192" }]);
    const index = (await db.query(`SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indpred IS NULL AS unconditional
      FROM pg_index i WHERE i.indexrelid='public.catalog_attribute_projection_text_idx'::regclass`)).rows[0];
    expect(index).toEqual({ definition: expect.stringContaining("USING btree (attribute_key, definition_version, text_value, sku_id)"), unconditional: true });
    const sample = Array.from({ length: 256 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("");
    let revision = 1;
    let inserted = 0;
    for (const kind of ["text", "localized_text"] as const) for (const scope of ["product", "variant"] as const) {
      for (const filterable of [false, true]) for (const bytes of [2_047, 2_048, 2_049]) {
        const valueType = kind === "text" ? { kind, maxLength: 16_384 } : { kind, maxLength: 16_384, locales: ["en"] };
        // Exercise the largest admitted key and version in the landed composite index.
        const key = "a".repeat(64);
        const definition: CatalogProductTypeInput = {
          key: "example:item", version: 2_147_483_647,
          units: [{ code: "openlup:g", dimension: "mass", integral: false }], netContentUnits: ["openlup:g"], dimensions: [], validateContent: () => [],
          attributes: [{ key, scope, valueType, required: false, cardinality: { min: 0, max: 1 }, filterable, facetable: filterable, public: true, displayOrder: 0, labels: {} }],
        };
        const value = kind === "text" ? sample.slice(0, bytes) : { en: sample.slice(0, bytes - 9) };
        const input = scope === "product" ? { productAttributes: { [key]: value }, skus: [{ id: attributeSku }] }
          : { skus: [{ id: attributeSku, attributes: { [key]: value } }] };
        const validation = await validateCatalogAttributes(definition, input);
        const prepared = prepareCatalogAttributeProjection(validation, String(revision++));
        if (bytes > 2_048) {
          expect(prepared).toMatchObject({ prepared: false, issues: [{ code: "attribute_projection_text_too_large" }] });
          continue;
        }
        if (!prepared.prepared) throw new Error("index-safe value refused preparation");
        const row = prepared.rows[0];
        const persisted = (await db.query(`INSERT INTO public.catalog_attribute_projection
          (sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind,text_value)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING octet_length(text_value) AS bytes`,
        [row.sku_id, row.publication_revision, row.attribute_key, row.definition_version, row.value_ordinal, row.value_kind, row.text_value])).rows[0];
        expect(persisted.bytes).toBe(bytes); inserted++;
      }
    }
    expect((await db.query("SELECT count(*)::int AS count FROM public.catalog_attribute_projection")).rows).toEqual([{ count: inserted }]);
    expect(inserted).toBe(16);
    // Bypassing the owner reproduces the real index failure on an incompressible value.
    await db.query("SAVEPOINT bypass_owner");
    await expect(db.query(`INSERT INTO public.catalog_attribute_projection
      (sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind,text_value)
      VALUES($1,$2,$3,2147483647,0,'text',$4)`, [attributeSku, revision, "a".repeat(64), sample.slice(0, 4_096)]))
      .rejects.toMatchObject({ code: "54000", message: expect.stringContaining("catalog_attribute_projection_text_idx") });
    await db.query("ROLLBACK TO SAVEPOINT bypass_owner");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
