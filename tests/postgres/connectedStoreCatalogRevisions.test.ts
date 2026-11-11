import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryConfig } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PostgresTransferError } from "@openlup/platform/portability";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
const at = "2026-09-15T00:00:00Z";
const products = [randomUUID(), randomUUID(), randomUUID()];
const latest = [randomUUID(), randomUUID()];
let source: JourneyInstallation, target: JourneyInstallation;
let packet: ConnectedNativeStoreCapture, freshTarget: ConnectedNativeStoreCapture;
let targetNumber = 0;

beforeAll(async () => {
  source = await resources.installation("catalog-source");
  for (const [index, product] of products.entries()) {
    await source.owner.query(`INSERT INTO public.catalog_products(id,slug,name,created_at,updated_at)
      VALUES($1,$2,'Synthetic document product',$3,$3)`, [product, `document-product-${index}`, at]);
    if (index !== 1) {
      const sku = randomUUID();
      await source.owner.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,created_at,updated_at)
        VALUES($1,$2,$3,'Synthetic SKU',$4,$4)`, [sku, product, `DOCUMENT-SKU-${index}`, at]);
      await source.owner.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [product, sku]);
    }
    if (index === 2) continue;
    for (const revision of [1, 2]) {
      await source.owner.query(`INSERT INTO public.catalog_product_document_revisions
        (id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest,created_at)
        VALUES($1,$2,$3,'synthetic.v1',$4,
          '{"amount":9007199254740993,"currency":"XXX","label":"Synthetic document"}',
          'https://example.invalid/catalog','{"source":"synthetic"}',$5,$6)`,
      [revision === 2 ? latest[index] : randomUUID(), product, revision,
        `document:${index}:${revision}`, String(revision).repeat(64), at]);
    }
    await source.owner.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [product, latest[index]]);
  }
  packet = await captureStoreJourney(source.owner, "catalog-document-source");
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  target = await resources.installation(`catalog-target-${++targetNumber}`);
  freshTarget = await captureStoreJourney(target.owner, "catalog-document-target");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const restore = (owner = target.owner, captured = packet) => restoreConnectedNativeStore({
  owner, installation: journeySelection, packet: captured, freshTarget,
});

// Observe or perturb real SQL on the owned transaction, without replacing any
// query result, schema object, constraint or qualification evidence.
function observedOwner(before: (sql: string, query: (sql: string, values?: unknown[]) => Promise<unknown>) => Promise<void>,
  onError: (sql: string, error: unknown) => void = () => undefined): Pool {
  return { async connect() {
    const client = await target.owner.connect();
    return {
      async query(sql: string | QueryConfig, values?: unknown[]) {
        const text = typeof sql === "string" ? sql : sql.text;
        await before(text, (statement, parameters) => client.query(statement, parameters));
        try { return typeof sql === "string" ? await client.query(sql, values) : await client.query(sql); }
        catch (error) { onError(text, error); throw error; }
      },
      release: (destroy?: boolean) => client.release(destroy),
    };
  } } as unknown as Pool;
}

// The existing connected-transfer deadline is 30 seconds per case. Setup has
// its separate container deadline; these cases keep retry at zero.
it("carries two revisions per revised product, resolves the latest pointer and replays byte-exactly", async () => {
  const before = await journeyCensus(source.owner);
  expect(packet.owned.find(table => table.table === "catalog_product_document_revisions")?.rows)
    .toEqual(before.catalog_product_document_revisions);
  expect(before.catalog_product_document_revisions).toHaveLength(4);
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect((await target.owner.query(`SELECT p.id,p.current_document_revision_id,r.product_id,r.revision_no,
    r.id=(SELECT r2.id FROM public.catalog_product_document_revisions r2
      WHERE r2.product_id=p.id ORDER BY r2.revision_no DESC LIMIT 1) AS latest
    FROM public.catalog_products p JOIN public.catalog_product_document_revisions r
      ON r.id=p.current_document_revision_id ORDER BY p.slug`)).rows)
    .toEqual(products.slice(0, 2).map((id, index) => ({ id, current_document_revision_id: latest[index],
      product_id: id, revision_no: 2, latest: true })));
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: true, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(before);
}, 105_000);

it("refuses another product's revision at the pointer foreign key and rolls back to pristine rows", async () => {
  const pristine = await journeyCensus(target.owner);
  expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
  const corrupted = structuredClone(packet);
  const table = corrupted.owned.find(value => value.table === "catalog_products")!;
  let patched = false;
  table.rows = table.rows.map(row => {
    if ((JSON.parse(row) as { id: string }).id !== products[0]) return row;
    const changed = row.replace(`"current_document_revision_id": "${latest[0]}"`,
      `"current_document_revision_id": "${latest[1]}"`);
    expect(changed).not.toBe(row);
    patched = true; return changed;
  });
  expect(patched).toBe(true);
  const { sha256: _old, ...body } = corrupted;
  corrupted.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  let pointerError: unknown;
  const owner = observedOwner(async () => undefined, (sql, error) => {
    if (sql.startsWith("UPDATE public.catalog_products p SET current_document_revision_id=")) pointerError = error;
  });
  await expect(restore(owner, corrupted)).rejects.toBeInstanceOf(PostgresTransferError);
  expect(pointerError).toMatchObject({ code: "23503",
    constraint: "catalog_products_current_document_revision_same_product_fkey" });
  expect(await journeyCensus(target.owner)).toEqual(pristine);
}, 60_000);

it("preserves a null document pointer and a null primary SKU without changing product rows", async () => {
  expect(await restore()).toMatchObject({ replayed: false });
  const before = await journeyCensus(source.owner), after = await journeyCensus(target.owner);
  expect(after.catalog_products).toEqual(before.catalog_products);
  expect((await target.owner.query(`SELECT id,current_document_revision_id,primary_sku_id
    FROM public.catalog_products WHERE id=$1`, [products[1]])).rows)
    .toEqual([{ id: products[1], current_document_revision_id: latest[1], primary_sku_id: null }]);
  expect((await target.owner.query(`SELECT p.id,p.current_document_revision_id,p.primary_sku_id IS NOT NULL AS has_sku,
    (SELECT count(*)::int FROM public.catalog_product_document_revisions r WHERE r.product_id=p.id) AS revisions
    FROM public.catalog_products p WHERE p.id=$1`, [products[2]])).rows)
    .toEqual([{ id: products[2], current_document_revision_id: null, has_sku: true, revisions: 0 }]);
}, 75_000);

it("refuses a changed staged product at the guarded pointer update and rolls back every row", async () => {
  const pristine = await journeyCensus(target.owner);
  let changed = false;
  const owner = observedOwner(async (sql, query) => {
    if (changed || !sql.startsWith("UPDATE public.catalog_products p SET current_document_revision_id=")) return;
    // This product has no primary SKU, so that separate cycle cannot mask a
    // missing document-pointer guard or exactly-one-row check.
    await query("UPDATE public.catalog_products SET name='Changed staged product' WHERE id=$1", [products[1]]);
    changed = true;
  });
  await expect(restore(owner)).rejects.toMatchObject({ code: "target_conflict", table: "catalog_products" });
  expect(changed).toBe(true);
  expect(await journeyCensus(target.owner)).toEqual(pristine);
}, 65_000);
