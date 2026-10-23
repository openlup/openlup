import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresBundleCatalogStore } from "@openlup/platform/catalog";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const now = "2026-05-20T12:00:00.000Z", before = "2026-05-01T00:00:00.000Z", after = "2026-06-01T00:00:00.000Z";
let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
let list: string, bundle: string, product: string, part: string;
const feedInput = { currency: "XXX", regionCode: "ZZ", atTime: now };
const executor = () => ({ query: (sql: string, values?: readonly unknown[]) => db.query(sql, values ? [...values] : undefined) });
const store = () => createPostgresBundleCatalogStore(executor(), { priceAuthority: "effective" });
const feed = () => store().listActiveBundleCompositions(feedInput);
function gtin(seed: number) {
  const body = `0000042${String(seed).padStart(5, "0")}`;
  const sum = [...body].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 1 : 3), 0);
  return body + String((10 - sum % 10) % 10);
}
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Effective bundle proof requires real PostgreSQL");
  container = await runPostgresContainer({ name: `bundle-effective-parity-${process.pid}`, password: "synthetic-parity" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Effective bundle PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool }).apply();
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);
beforeEach(async () => {
  db = await pool.connect(); await db.query("BEGIN");
  product = (await db.query("INSERT INTO public.catalog_products(slug,name) VALUES ('parity-parts','Synthetic parts') RETURNING id")).rows[0].id;
  const skus: string[] = [];
  for (const [index, code] of ["PARITY-P", "PARITY-Q"].entries()) {
    const id = (await db.query("INSERT INTO public.catalog_skus(product_id,sku,title,net_weight_g,status,sellable_standalone,sellable_in_subscription) VALUES ($1,$2,$2,250,'active',true,true) RETURNING id", [product, code])).rows[0].id;
    skus.push(id);
    await db.query("INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary) VALUES ($1,'synthetic','gtin',$2,'unit',1,true)", [id, gtin(index + 21)]);
  }
  part = skus[1];
  const revision = (await db.query("INSERT INTO public.catalog_product_document_revisions(product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest) VALUES ($1,1,'synthetic.v1','synthetic:document','{}','synthetic:source','{}',$2) RETURNING id", [product, "b".repeat(64)])).rows[0].id;
  await db.query("UPDATE public.catalog_products SET primary_sku_id=$2,current_document_revision_id=$3 WHERE id=$1", [product, skus[0], revision]);
  list = (await db.query("INSERT INTO public.price_lists(name,region_code,currency,valid_from,valid_to) VALUES ('Synthetic authority','ZZ','XXX',$1,$2) RETURNING id", [before, after])).rows[0].id;
  for (const sku of skus) for (const [mode, amount] of [["one_time", 1200], ["subscription", 1000], ["any", 1100]]) {
    await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from,valid_to) VALUES ($1,$2,$3,1,$4,$5,$6)", [list, sku, mode, amount, before, after]);
  }
  bundle = (await db.query("INSERT INTO public.catalog_bundles(code,title,status,fulfillment_mode) VALUES ('PARITY-SET','Synthetic collection','active','virtual') RETURNING id")).rows[0].id;
  for (const [index, sku] of skus.entries()) await db.query("INSERT INTO public.catalog_bundle_components(bundle_id,catalog_sku_id,quantity,is_addon,sort_order) VALUES ($1,$2,1,$3,$4)", [bundle, sku, index === 1, index]);
  for (const [mode, amount] of [["one_time", 1600], ["subscription", 1400], ["any", 1700]]) await db.query("INSERT INTO public.catalog_bundle_prices(bundle_id,price_list_id,mode,target_price_minor,valid_from,valid_to) VALUES ($1,$2,$3,$4,$5,$6)", [bundle, list, mode, amount, before, after]);
});
afterEach(async () => { if (db) { await db.query("ROLLBACK"); db.release(); } });
it("reads effective windows and region through real SQL while retaining target history", async () => {
  await db.query("INSERT INTO public.catalog_bundle_prices(bundle_id,price_list_id,mode,target_price_minor,valid_from) VALUES ($1,$2,'one_time',1900,$3)", [bundle, list, after]);
  const detail = await store().getBundle({ code: "PARITY-SET", ...feedInput });
  expect(detail).toMatchObject({ resolvedPriceListId: list, resolvedTargetPrice: { targetPriceMinor: 1600 }, prices: expect.arrayContaining([expect.objectContaining({ targetPriceMinor: 1900 })]) });
  expect(await feed()).toMatchObject([{ code: "PARITY-SET", targetPriceMinor: 1600, components: [{ referenceUnitPriceMinor: 1200 }, { referenceUnitPriceMinor: 1200 }] }]);
  expect(await store().listActiveBundleCompositions({ ...feedInput, regionCode: "YY" })).toEqual([]);
  expect(await store().listActiveBundleCompositions({ ...feedInput, atTime: after })).toEqual([]);
  expect(await store().listActiveBundleCompositions({ ...feedInput, atTime: before })).toHaveLength(1);
  expect(await store().getBundle({ code: "MISSING", ...feedInput })).toBeNull();
});
it("selects own one_time by default and exact modes before any for target and anchors", async () => {
  expect(await store().getBundle({ code: "PARITY-SET", atTime: now })).toMatchObject({ resolvedPriceListId: list, resolvedTargetPrice: { mode: "one_time", targetPriceMinor: 1600 } });
  expect(await store().listActiveBundleCompositions({ ...feedInput, mode: "subscription" })).toMatchObject([{ targetPriceMinor: 1400, mode: "subscription", components: [{ referenceUnitPriceMinor: 1000 }, { referenceUnitPriceMinor: 1000 }] }]);
  await db.query("DELETE FROM public.catalog_bundle_prices WHERE mode='one_time'");
  await db.query("DELETE FROM public.price_entries WHERE mode='one_time'");
  expect(await feed()).toMatchObject([{ targetPriceMinor: 1700, mode: "any", components: [{ referenceUnitPriceMinor: 1100 }, { referenceUnitPriceMinor: 1100 }] }]);
  expect(await store().getBundle({ code: "PARITY-SET", atTime: now })).toMatchObject({ resolvedTargetPrice: { mode: "any", targetPriceMinor: 1700 } });
});
it("refuses overlapping effective lists in detail and feed instead of choosing creation order", async () => {
  await db.query("INSERT INTO public.price_lists(name,region_code,currency,valid_from,valid_to) VALUES ('Overlapping synthetic list','ZZ','XXX',$1,$2)", [now, after]);
  await expect(store().getBundle({ code: "PARITY-SET", ...feedInput })).rejects.toThrow("bundle_price_list_ambiguous");
  await expect(feed()).rejects.toThrow("bundle_price_list_ambiguous");
});
it("refuses duplicate effective component anchors in both detail and whole feed", async () => {
  await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from,valid_to) VALUES ($1,$2,'one_time',1,1250,$3,$4)", [list, part, now, after]);
  await expect(store().getBundle({ code: "PARITY-SET", ...feedInput })).rejects.toThrow("bundle_price_ambiguous");
  await expect(feed()).rejects.toThrow("bundle_price_ambiguous");
});
it("requires gross minQty-one anchors and refuses a zero anchor without shortening the BOM", async () => {
  await db.query("DELETE FROM public.price_entries WHERE mode='any'");
  for (const change of ["amount_kind='net'", "min_qty=4", "unit_price_minor=0"]) {
    await db.query("SAVEPOINT invalid_anchor");
    await db.query(`UPDATE public.price_entries SET ${change} WHERE variant_id=$1 AND mode='one_time'`, [part]);
    const detail = await store().getBundle({ code: "PARITY-SET", ...feedInput });
    expect(detail!.components).toHaveLength(2);
    expect(detail!.components[1].referenceUnitPriceMinor).toBe(change === "unit_price_minor=0" ? 0 : null);
    expect(await feed()).toEqual([]);
    await db.query("ROLLBACK TO SAVEPOINT invalid_anchor");
  }
  expect(await feed()).toHaveLength(1);
});
it("requires document, primary GTIN, status, weight and mode sellability for every BOM component", async () => {
  const changes: [string, string[]][] = [
    ["UPDATE public.catalog_products SET current_document_revision_id=NULL WHERE id=$1", [product]],
    ["UPDATE public.catalog_products SET primary_sku_id=NULL WHERE id=$1", [product]],
    ["DELETE FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1", [part]],
    ["UPDATE public.catalog_sku_identifiers SET normalized_value='0000000000001' WHERE catalog_sku_id=$1", [part]],
    ["UPDATE public.catalog_skus SET status='archived' WHERE id=$1", [part]],
    ["UPDATE public.catalog_products SET status='archived' WHERE id=$1", [product]],
    ["UPDATE public.catalog_skus SET net_weight_g=0 WHERE id=$1", [part]],
    ["UPDATE public.catalog_skus SET sellable_standalone=false WHERE id=$1", [part]],
  ];
  for (const [sql, values] of changes) {
    await db.query("SAVEPOINT unready"); await db.query(sql, values);
    expect(await feed(), sql).toEqual([]);
    expect((await store().getBundle({ code: "PARITY-SET", ...feedInput }))!.components).toHaveLength(2);
    await db.query("ROLLBACK TO SAVEPOINT unready");
  }
  await db.query("UPDATE public.catalog_skus SET sellable_in_subscription=false WHERE id=$1", [part]);
  expect(await feed()).toHaveLength(1);
  expect(await store().listActiveBundleCompositions({ ...feedInput, mode: "subscription" })).toEqual([]);
});
