import { nativeCatalogPublication } from "@openlup/platform/catalog";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryConfig } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPostgresCatalogPublicationReads } from "../../server/adapters/postgres/catalogPublicationReads.js";
import { actorId, catalogQuantityCharacterization, decisionReceipt, decisionRow, documentRow, fixture, graph, insertGraph, installPublicationActors, invalidReceiptResults, json, transaction, malformedPublicationPackets, sealedPublicationRemedy } from "./catalogPublicationFixture.js";
import { PostgresTransferError } from "@openlup/platform/portability";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation, type JourneyTargetTemplate } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const { catalogPublicationAdmissionRefusal } = nativeCatalogPublication;

const resources = storeJourneyResources();
const at = "2026-09-15T00:00:00Z";
const products = [randomUUID(), randomUUID(), randomUUID()];
const latest = [randomUUID(), randomUUID()];
let source: JourneyInstallation, target: JourneyInstallation, targets: JourneyTargetTemplate;
let packet: ConnectedNativeStoreCapture, freshTarget: ConnectedNativeStoreCapture;
let targetNumber = 0;

beforeAll(async () => {
  [source, targets] = await Promise.all([
    resources.installation("catalog-source"),
    resources.targetTemplate("catalog-target"),
  ]);
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
  for (const [index, { grams, tuple }] of catalogQuantityCharacterization.entries()) {
    await source.owner.query(`INSERT INTO public.catalog_skus(product_id,sku,title,net_weight_g,
      net_content_dimension,net_content_unit,net_content_unscaled,net_content_scale)
      VALUES ($1,$2,'Legacy quantity',$3,$4,$5,$6,$7)`, [
      products[0], `QUANTITY-LEGACY-${index}`, grams, tuple?.[0] ?? null, tuple?.[1] ?? null, tuple?.[2] ?? null, tuple ? 0 : null,
    ]);
  }
  packet = await captureStoreJourney(source.owner, "catalog-document-source");
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  target = await targets.nextTarget(`catalog-target-${++targetNumber}`);
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

// Each case bound is about 4x its slowest hosted run, rounded up to 5 s.
// Container setup retains its separate deadline; cases keep retry at zero.
it("carries two revisions per revised product, resolves the latest pointer and replays byte-exactly", async () => {
  const before = await journeyCensus(source.owner);
  expect(packet.owned.find(table => table.table === "catalog_product_document_revisions")?.rows)
    .toEqual(before.catalog_product_document_revisions);
  expect(before.catalog_product_document_revisions).toHaveLength(4);
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect((await target.owner.query(`SELECT net_weight_g,net_content_dimension,net_content_unit,
    net_content_unscaled::text,net_content_scale FROM public.catalog_skus WHERE sku LIKE 'QUANTITY-LEGACY-%' ORDER BY sku`)).rows)
    .toEqual(catalogQuantityCharacterization.map(({ grams, tuple }) => ({
      net_weight_g: grams, net_content_dimension: tuple?.[0] ?? null, net_content_unit: tuple?.[1] ?? null,
      net_content_unscaled: tuple ? String(tuple[2]) : null, net_content_scale: tuple ? 0 : null,
    })));
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

const legacyFactsSql = `CASE $2::text
  WHEN 'a document field' THEN jsonb_build_object('document', d.document_payload)
  WHEN 'serialized document bytes' THEN to_jsonb(d.document_payload::text)
  WHEN 'an arbitrary object' THEN '{"other":"fact"}'::jsonb
END`;

it.each(["a document field", "serialized document bytes", "an arbitrary object"] as const)(
  "refuses %s on the first legacy SKU projection write and during restore", async shape => {
  expect(packet.owned.find(entry => entry.table === "catalog_publications")!.rows).toEqual([]);
  const { rows: [placed] } = await source.owner.query<{ id: string; row: string; facts: string }>(
    "SELECT s.id, (to_jsonb(s) || jsonb_build_object('publication_facts', p.facts))::text AS row, p.facts::text AS facts "
    + "FROM public.catalog_skus s JOIN public.catalog_products c ON c.id=s.product_id "
    + "JOIN public.catalog_product_document_revisions d ON d.id=c.current_document_revision_id "
    + `CROSS JOIN LATERAL (SELECT ${legacyFactsSql} AS facts) p WHERE c.id=$1`, [products[0], shape],
  );
  if (!placed) throw new Error("Legacy SKU fixture is missing");
  const refused = await transaction(source.owner, db => db.query(
    "UPDATE public.catalog_skus SET publication_facts=$2 WHERE id=$1", [placed.id, placed.facts],
  )).catch(error => error);
  const pristine = await journeyCensus(target.owner);
  const edited = structuredClone(packet);
  const table = edited.owned.find(entry => entry.table === "catalog_skus")!;
  const index = table.rows.findIndex(row => JSON.parse(row).id === placed.id);
  expect(index).toBeGreaterThanOrEqual(0);
  table.rows[index] = placed.row;
  rehash(edited);
  const refusedTransfer = await restore(target.owner, edited).catch(error => error);
  expect(refusedTransfer).toMatchObject({
    code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_facts_invalid" },
  });
  expect(catalogPublicationAdmissionRefusal(refused)).toMatchObject({ reason: "publication_facts_invalid" });
  expect((await source.owner.query("SELECT publication_facts FROM public.catalog_skus WHERE id=$1", [placed.id])).rows)
    .toEqual([{ publication_facts: null }]);
  expect(await journeyCensus(target.owner)).toEqual(pristine);
}, 65_000);

async function opaqueProductProjection(shape = "a document field") {
  const { rows: [projection] } = await source.owner.query<{ row: string; facts: string }>(
    `SELECT (to_jsonb(p) || jsonb_build_object('publication_facts',f.facts))::text AS row, f.facts::text AS facts
    FROM public.catalog_products p JOIN public.catalog_product_document_revisions d ON d.id=p.current_document_revision_id
    CROSS JOIN LATERAL (SELECT ${legacyFactsSql} AS facts) f WHERE p.id=$1`, [products[0], shape],
  );
  if (!projection) throw new Error("Legacy product fixture is missing");
  return projection;
}

const productCarrierRefusal = {
  code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_facts_invalid" },
};

function packetWithProductProjection(row: string) {
  const edited = structuredClone(packet);
  const table = edited.owned.find(entry => entry.table === "catalog_products")!;
  const index = table.rows.findIndex(row => JSON.parse(row).id === products[0]);
  expect(index).toBeGreaterThanOrEqual(0);
  table.rows[index] = row;
  rehash(edited);
  return edited;
}

async function storeOpaqueProductProjection(owner: Pool, facts: string) {
  // Model a row already on disk while leaving transfer admission active.
  await transaction(owner, async db => {
    await db.query("SET CONSTRAINTS catalog_products_lifecycle_projection_final IMMEDIATE");
    await db.query("ALTER TABLE public.catalog_products DISABLE TRIGGER catalog_products_publication_pointer_fence");
    await db.query("UPDATE public.catalog_products SET publication_facts=$2 WHERE id=$1", [products[0], facts]);
    await db.query("ALTER TABLE public.catalog_products ENABLE TRIGGER catalog_products_publication_pointer_fence");
  });
}

it("refuses an opaque document in the legacy product publication projection on write and restore", async () => {
  expect(packet.owned.find(entry => entry.table === "catalog_publications")!.rows).toEqual([]);
  const projection = await opaqueProductProjection();
  const pristine = await journeyCensus(target.owner);
  await expect(restore(target.owner, packetWithProductProjection(projection.row))).rejects.toMatchObject(productCarrierRefusal);
  expect(await journeyCensus(target.owner)).toEqual(pristine);

  const refused = await transaction(source.owner, db => db.query(
    "UPDATE public.catalog_products SET publication_facts=$2 WHERE id=$1", [products[0], projection.facts],
  )).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(refused)).toMatchObject({ reason: "publication_facts_invalid" });
  expect((await source.owner.query("SELECT publication_facts FROM public.catalog_products WHERE id=$1", [products[0]])).rows)
    .toEqual([{ publication_facts: null }]);
}, 65_000);

it.each(["serialized document bytes", "an arbitrary object"] as const)(
  "refuses %s as the whole legacy product projection on INSERT and restore", async shape => {
    expect(packet.owned.find(entry => entry.table === "catalog_publications")!.rows).toEqual([]);
    const projection = await opaqueProductProjection(shape);
    const productId = randomUUID();
    const inserted = Symbol("owner insert succeeded");
    const ownerError = await transaction(source.owner, async db => {
      await db.query("INSERT INTO public.catalog_products(id,slug,name,publication_facts) VALUES($1,$2,'Synthetic product',$3)",
        [productId, `synthetic-${productId}`, projection.facts]);
      throw inserted;
    }).catch(error => error);
    const pristine = await journeyCensus(target.owner);
    const transferError = await restore(target.owner, packetWithProductProjection(projection.row)).catch(error => error);
    expect(catalogPublicationAdmissionRefusal(ownerError)).toMatchObject({ reason: "publication_facts_invalid" });
    expect(transferError).toMatchObject(productCarrierRefusal);
    expect(await journeyCensus(target.owner)).toEqual(pristine);
  }, 65_000);

it("refuses an opaque document in a stored legacy product publication projection during capture", async () => {
  const { facts } = await opaqueProductProjection();
  await storeOpaqueProductProjection(source.owner, facts);
  try {
    await expect(captureStoreJourney(source.owner, "catalog-document-source")).rejects.toMatchObject(productCarrierRefusal);
  } finally {
    await source.owner.query("UPDATE public.catalog_products SET publication_facts=NULL WHERE id=$1", [products[0]]);
  }
}, 65_000);

it("refuses an opaque document in the same stored legacy product projection during exact replay", async () => {
  expect(await restore()).toMatchObject({ replayed: false });
  const projection = await opaqueProductProjection();
  const edited = packetWithProductProjection(projection.row);
  await storeOpaqueProductProjection(target.owner, projection.facts);
  const before = await journeyCensus(target.owner);
  expect(before.catalog_products).toContain(projection.row);
  await expect(restore(target.owner, edited)).rejects.toMatchObject(productCarrierRefusal);
  expect(await journeyCensus(target.owner)).toEqual(before);
}, 65_000);

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

it("restores reordered sealed history and recovers the original publication after reconnect", async () => {
  await installPublicationActors(source.owner);
  const data = fixture();
  const { first, second, receipt } = await transaction(source.owner, async db => {
    const first = await graph(db, data);
    const receipt = await insertGraph(db, first);
    const second = await graph(db, data, first.head);
    await insertGraph(db, second);
    const unpublished = await graph(db, fixture(), null, false);
    await decisionRow(db, unpublished);
    await decisionReceipt(db, unpublished);
    return { first, second, receipt };
  });
  await source.owner.query("UPDATE public.catalog_products SET name='Later draft name' WHERE id=$1", [data.productId]);
  await expect(captureStoreJourney(source.owner, "catalog-publication-drift")).rejects.toMatchObject({
    code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_changed" },
  });
  await source.owner.query("UPDATE public.catalog_products SET name=$2 WHERE id=$1", [data.productId, second.product.name]);
  await source.owner.query("UPDATE public.catalog_skus SET net_weight_g=200 WHERE id=$1", [data.skuId]);
  await expect(captureStoreJourney(source.owner, "catalog-publication-weight-drift")).rejects.toMatchObject({
    code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_changed" },
  });
  await source.owner.query("UPDATE public.catalog_skus SET net_weight_g=100 WHERE id=$1", [data.skuId]);
  const captured = await captureStoreJourney(source.owner, "catalog-publication-source");
  const pristine = await journeyCensus(target.owner);
  const savedHead = captured.owned.find(table => table.table === "catalog_publications")!.rows
    .map(text => JSON.parse(text) as { id: string; canonical_state: string }).find(row => row.id === second.issueId)!;
  const manifestRefusal = { code: "target_conflict", cause: {
    reason: "publication_details_invalid",
    message: sealedPublicationRemedy,
  } };
  const storeHeadText = (value: string) => transaction(source.owner, async db => {
    await db.query("ALTER TABLE public.catalog_publications DISABLE TRIGGER catalog_publications_issued");
    await db.query("UPDATE public.catalog_publications SET canonical_state=$2,digest=$3 WHERE id=$1",
      [second.issueId, value, createHash("sha256").update(value).digest("hex")]);
    await db.query("ALTER TABLE public.catalog_publications ENABLE TRIGGER catalog_publications_issued");
  });
  const connect = vi.fn(async () => { throw new Error("An invalid packet must never connect"); });
  const disconnectedOwner = { connect } as unknown as Pool;
  for (const { text: value, path, digest } of malformedPublicationPackets(savedHead.canonical_state)) {
    const refusal = { ...manifestRefusal, cause: { ...manifestRefusal.cause, path } };
    await storeHeadText(value);
    try {
      await expect(captureStoreJourney(source.owner, "catalog-malformed-manifest")).rejects.toMatchObject(refusal);
    } finally {
      await storeHeadText(savedHead.canonical_state);
    }
    const edited = structuredClone(captured);
    const issues = edited.owned.find(table => table.table === "catalog_publications")!;
    issues.rows = issues.rows.map(text => JSON.parse(text).id === second.issueId
      ? JSON.stringify({ ...JSON.parse(text), canonical_state: value, digest }) : text);
    rehash(edited);
    await expect(restore(disconnectedOwner, edited)).rejects.toMatchObject(refusal);
    expect(await journeyCensus(target.owner)).toEqual(pristine);
  }

  const malformedId = structuredClone(captured);
  const revisionsWithMalformedId = malformedId.owned.find(table => table.table === "catalog_sku_revisions")!;
  revisionsWithMalformedId.rows[0] = JSON.stringify({ ...JSON.parse(revisionsWithMalformedId.rows[0]!), id: "not-a-uuid" });
  rehash(malformedId);
  await expect(restore(disconnectedOwner, malformedId)).rejects.toMatchObject({
    code: "target_conflict", cause: { reason: "publication_revision_invalid",
      path: "catalog_sku_revisions.0.id", message: sealedPublicationRemedy },
  });
  expect(connect).not.toHaveBeenCalled();

  const tampered = structuredClone(captured);
  const revisions = tampered.owned.find(table => table.table === "catalog_publications")!;
  const originalRow = revisions.rows[0]!;
  const row = JSON.parse(originalRow) as { canonical_state: string; digest: string };
  const manifest = JSON.parse(row.canonical_state) as { product: { document: { sourceRef: string } } };
  manifest.product.document.sourceRef = "example:wrong-source";
  row.canonical_state = json(manifest);
  row.digest = createHash("sha256").update(row.canonical_state).digest("hex");
  // Let PostgreSQL encode the row exactly as capture/restore does.
  revisions.rows[0] = (await source.owner.query<{ value: string }>(`SELECT to_jsonb(x)::text AS value FROM
    (SELECT set_config('TimeZone','UTC',true)) zone,
    jsonb_populate_record(NULL::public.catalog_publications,$1::jsonb) x`, [JSON.stringify(row)])).rows[0]!.value;
  rehash(tampered);
  await expect(restore(target.owner, tampered)).rejects.toMatchObject({
    code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_content_changed" },
  });
  expect(await journeyCensus(target.owner)).toEqual(pristine);

  const malformed = structuredClone(captured);
  const skuRows = malformed.owned.find(table => table.table === "catalog_sku_revisions")!;
  const sku = JSON.parse(skuRows.rows[0]!) as { full_facts: string; digest: string };
  sku.full_facts = sku.full_facts.replace(/"Article(?: 2)?"/, '"\\u0000"');
  sku.digest = createHash("sha256").update(sku.full_facts).digest("hex");
  skuRows.rows[0] = (await source.owner.query<{ value: string }>(`SELECT to_jsonb(x)::text AS value FROM
    jsonb_populate_record(NULL::public.catalog_sku_revisions,$1::jsonb) x`, [JSON.stringify(sku)])).rows[0]!.value;
  rehash(malformed);
  await expect(restore(target.owner, malformed)).rejects.toMatchObject({
    code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_revision_invalid" },
  });
  expect(await journeyCensus(target.owner)).toEqual(pristine);

  const edited = structuredClone(captured);
  const historyRows = edited.owned.find(table => table.table === "catalog_publications")!.rows;
  const receiptRows = edited.owned.find(table => table.table === "catalog_operator_receipts")!.rows;
  const oldIndex = historyRows.findIndex(text => JSON.parse(text).id === first.issueId);
  const oldPublication = JSON.parse(historyRows[oldIndex]!);
  const oldState = JSON.parse(oldPublication.canonical_state);
  oldState.product.name = "Different historic title";
  oldPublication.canonical_state = json(oldState);
  oldPublication.digest = createHash("sha256").update(oldPublication.canonical_state).digest("hex");
  historyRows[oldIndex] = JSON.stringify(oldPublication);
  const oldReceiptIndex = receiptRows.findIndex(text => JSON.parse(text).publication_id === first.issueId);
  const oldReceipt = JSON.parse(receiptRows[oldReceiptIndex]!);
  oldReceipt.result = json({ ...JSON.parse(oldReceipt.result), publicationDigest: oldPublication.digest });
  receiptRows[oldReceiptIndex] = JSON.stringify(oldReceipt);
  rehash(edited);
  await expect(restore(target.owner, edited)).rejects.toMatchObject({
    code: "target_conflict", cause: { reason: "publication_post_state_changed" },
  });
  expect(await journeyCensus(target.owner)).toEqual(pristine);

  for (const [kind, result] of Object.entries(invalidReceiptResults)) {
    const invalidResult = structuredClone(captured);
    const invalidRows = invalidResult.owned.find(table => table.table === "catalog_operator_receipts")!.rows;
    invalidRows[oldReceiptIndex] = JSON.stringify({ ...JSON.parse(invalidRows[oldReceiptIndex]!), result });
    rehash(invalidResult);
    const failedStatements: string[] = [];
    const owner = observedOwner(async () => undefined, sql => { failedStatements.push(sql); });
    await expect(restore(owner, invalidResult), kind).rejects.toMatchObject({
      code: "target_conflict", cause: { reason: "publication_receipt_input_invalid",
        message: "The saved command result contains invalid text or structure. Restore the original result from a verified copy or ask the store operator to recover it." },
    });
    expect(failedStatements, kind).toEqual(["SET CONSTRAINTS ALL IMMEDIATE"]);
    expect(await journeyCensus(target.owner), kind).toEqual(pristine);
  }

  const disconnected = { async connect() {
    const client = await target.owner.connect();
    client.release(true);
    return { query: client.query.bind(client), release: () => undefined };
  } } as unknown as Pool;
  await expect(restore(disconnected, captured)).rejects.toMatchObject({ code: "database_unavailable" });

  captured.owned.reverse();
  for (const table of captured.owned) table.rows.reverse();
  rehash(captured);
  expect(await restore(target.owner, captured)).toEqual({ captureSha256: captured.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(await journeyCensus(source.owner));
  expect(await restore(target.owner, captured)).toMatchObject({ replayed: true });
  const reader = createPostgresCatalogPublicationReads({
    transactions: { run: work => transaction(target.owner, work) },
    authorizeHuman: async () => ({ ok: true, userId: actorId, role: "admin", isMachineActor: false }),
  });
  const actor = (await reader.authorize(null))!;
  expect(await reader.readbackV2(first.head)).toMatchObject({ outcome: "page", head: first.head });
  expect(await reader.reads.current(data.productId)).toMatchObject({ outcome: "found", head: second.head });
  expect(await reader.receipt({ productId: data.productId, commandKey: first.commandKey }, actor)).toEqual({ outcome: "found", receipt });

  await target.owner.query("UPDATE public.catalog_products SET name='Later draft name' WHERE id=$1", [data.productId]);
  const drifted = await journeyCensus(target.owner);
  const replay = structuredClone(captured);
  const productRows = replay.owned.find(table => table.table === "catalog_products")!.rows;
  const index = productRows.findIndex(text => JSON.parse(text).id === data.productId);
  expect(index).toBeGreaterThanOrEqual(0);
  productRows[index] = drifted.catalog_products.find(text => JSON.parse(text).id === data.productId)!;
  rehash(replay);
  await expect(restore(target.owner, replay)).rejects.toMatchObject({
    code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_changed" },
  });
  expect(await journeyCensus(target.owner)).toEqual(drifted);

  await target.owner.query("UPDATE public.catalog_products SET name=$2 WHERE id=$1", [data.productId, second.product.name]);
  await target.owner.query("UPDATE public.catalog_skus SET net_weight_g=200 WHERE id=$1", [data.skuId]);
  const weighed = await journeyCensus(target.owner);
  const weightReplay = structuredClone(captured);
  for (const table of weightReplay.owned) if (table.table === "catalog_products" || table.table === "catalog_skus") table.rows = [...weighed[table.table]!];
  rehash(weightReplay);
  await expect(restore(target.owner, weightReplay)).rejects.toMatchObject({
    code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_changed" },
  });
  expect(await journeyCensus(target.owner)).toEqual(weighed);
});

it("refuses a retained registration whose original text is a JSON object during restore", async () => {
  if (!(await source.owner.query("SELECT 1 FROM public.platform_human_principals WHERE principal_id=$1", [actorId])).rows.length) {
    await installPublicationActors(source.owner);
  }
  const data = fixture();
  const origin = await transaction(source.owner, async db => {
    const older = await graph(db, data, null, true, { documentText: "{}" });
    await documentRow(db, older);
    return older;
  });
  await transaction(source.owner, async db => {
    const issuing = await graph(db, data, null, false, { draftRevision: 2, retainedSource: origin.source, documentText: "{}" });
    await insertGraph(db, issuing, { existingDocument: true });
  });
  const captured = await captureStoreJourney(source.owner, "catalog-registration-text");
  const tampered = structuredClone(captured);
  const drafts = tampered.owned.find(table => table.table === "catalog_draft_revisions")!.rows;
  const index = drafts.findIndex(text => JSON.parse(text).draft_id === data.draftId && JSON.parse(text).revision === 1);
  expect(index).toBeGreaterThanOrEqual(0);
  const draft = JSON.parse(drafts[index]!) as { payload: { publication: { operations: { op: string; canonicalText?: unknown }[] } } };
  const registration = draft.payload.publication.operations.find(operation => operation.op === "register_document_revision")!;
  expect(registration.canonicalText).toBe("{}");
  registration.canonicalText = {};
  drafts[index] = (await source.owner.query<{ value: string }>(`SELECT to_jsonb(x)::text AS value FROM
    (SELECT set_config('TimeZone','UTC',true)) zone,
    jsonb_populate_record(NULL::public.catalog_draft_revisions,$1::jsonb) x`, [JSON.stringify(draft)])).rows[0]!.value;
  rehash(tampered);
  const pristine = await journeyCensus(target.owner);
  await expect(restore(target.owner, tampered)).rejects.toMatchObject({
    code: "target_conflict", cause: { outcome: "validation_issue", reason: "publication_content_changed" },
  });
  expect(await journeyCensus(target.owner)).toEqual(pristine);
  expect(await restore(target.owner, captured)).toMatchObject({ replayed: false });
}, 65_000);

function rehash(value: ConnectedNativeStoreCapture) {
  const { sha256: _previous, ...body } = value;
  value.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function repin(input: ConnectedNativeStoreCapture, catalogueId: string, tables = input.compatible.tables) {
  const { sha256: _captureDigest, ...body } = input;
  const { sha256: _compatDigest, ...fields } = body.compatible;
  const encoded = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const projected = { ...fields, catalogueId, tables };
  const result = { ...body, compatible: { ...projected, sha256: encoded(projected) } };
  return { ...result, sha256: encoded(result) };
}

async function captureTradeIdentifier(issuer: string, marker: string | null) {
  const sku = randomUUID();
  await source.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Legacy trade item')",
    [sku, products[2], sku]);
  const identifier = randomUUID();
  await source.owner.query(`INSERT INTO public.catalog_sku_identifiers
    (id,catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,scheme)
    VALUES($1,$2,$3,'gtin','05901234123457','unit',1,$4)`, [identifier, sku, issuer, marker]);
  const capture = await captureStoreJourney(source.owner, "catalog-identifier-source");
  await source.owner.query("DELETE FROM public.catalog_sku_identifiers WHERE id=$1", [identifier]);
  await source.owner.query("DELETE FROM public.catalog_skus WHERE id=$1", [sku]);
  return { capture, identifier };
}

it("restores marked GTINs, and removes the marker only when the target explicitly changes it", async () => {
  const { capture, identifier } = await captureTradeIdentifier("modern", "gs1:gtin");
  expect(await restore(target.owner, capture)).toMatchObject({ replayed: false });
  expect((await target.owner.query("SELECT scheme FROM public.catalog_sku_identifiers WHERE id=$1", [identifier])).rows)
    .toEqual([{ scheme: "gs1:gtin" }]);
  await target.owner.query("UPDATE public.catalog_sku_identifiers SET scheme=NULL WHERE id=$1", [identifier]);
  expect((await target.owner.query("SELECT normalized_value,scheme FROM public.catalog_sku_identifiers WHERE id=$1", [identifier])).rows)
    .toEqual([{ normalized_value: "05901234123457", scheme: null }]);
}, 105_000);

it("refuses a differently shaped predecessor and an unknown inventory", async () => {
  const { capture } = await captureTradeIdentifier("historic", null);
  const table = capture.owned.find(entry => entry.table === "catalog_sku_identifiers")!;
  const historic = "c19175002e39e2b4100841e7138759a4dd07fe3158ebd3ce5f7283a5e8d538a9";
  table.columns = table.columns.filter(column => column.name !== "scheme");
  table.rows = (await source.owner.query(`SELECT (value::jsonb-'scheme')::text AS row
    FROM unnest($1::text[]) AS rows(value)`, [table.rows])).rows.map(row => row.row);
  await expect(restore(target.owner, repin(packet, "a".repeat(64)))).rejects.toMatchObject({ code: "schema_conflict" });
  const historicalTables = capture.compatible.tables.filter(entry => entry.table !== "commerce_checkout_attempt_ledger");
  await expect(restore(target.owner, repin(capture, historic, historicalTables))).rejects.toMatchObject({
    code: "schema_conflict", remedy: "upgrade the source, then capture",
  });
}, 105_000);

it("refuses a previously admitted separate-migrator inventory even if rows have the current shape", async () => {
  const predecessor = repin(packet, "b80abf637c8f3f6f854fcac09c88c6b9774857f93c41f0f94664e20f7e62b385");
  await expect(restore(target.owner, predecessor)).rejects.toMatchObject({
    code: "schema_conflict", remedy: "upgrade the source, then capture",
  });
}, 105_000);

it("transfers same-SKU governed bindings and preserves legacy NULL facts", async () => {
  if (!(await source.owner.query("SELECT 1 FROM public.platform_human_principals WHERE principal_id=$1", [actorId])).rowCount)
    await installPublicationActors(source.owner);
  const data = fixture();
  const { first, second } = await transaction(source.owner, async db => {
    const first = await graph(db, data, null, true, { lifecycle: "active" });
    await insertGraph(db, first);
    const second = await graph(db, data, first.head, true, { lifecycle: "withdrawn" });
    await insertGraph(db, second);
    return { first, second };
  });
  const subscription = randomUUID(), client = randomUUID(), order = randomUUID();
  const facts = first.facts as typeof first.facts & { optionDigest: string };
  const product = first.product as typeof first.product & { definitionDigest: string };
  const acceptance = { schemaVersion: 2, lines: [{ schemaVersion: 2, skuId: data.skuId, skuCode: facts.code,
    skuRevisionId: first.skuRevisionId, publicationHead: first.head, typeRef: product.type,
    netContent: facts.netContent, optionDigest: facts.optionDigest, definitionDigest: product.definitionDigest }] };
  await transaction(source.owner, async db => {
    await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
    await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days) VALUES($1,$2,28)", [subscription, client]);
    await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,currency_code,unit_price_minor,catalog_sku_revision_id)
      SELECT $1,id,1,0,'XXX',100,CASE WHEN id=$2 THEN $3::uuid END FROM public.catalog_skus WHERE id=$2 OR product_id=$4`,
    [subscription, data.skuId, first.skuRevisionId, products[0]]);
    await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'cancelled','XXX',0)", [order, client]);
    const key = `receipt:${order}`;
    await db.query("SELECT public.catalog_attach_order_acceptance($1,$2,$3,$4)", [order, json(acceptance), key, json({ [facts.code]: 1 })]);
    await db.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
      VALUES($1,$2,$3,$4)`, [key, "a".repeat(32), order, json({ orderDraft: { orderId: `order_${order}`,
      quoteSnapshot: { quote: { lines: [{ sku: facts.code, quantity: 1 }] } } } })]);
  });
  const captured = await captureStoreJourney(source.owner, "governed-lifecycle-source");
  await expect(restore(target.owner, captured)).resolves.toMatchObject({ replayed: false });
  const rows = await target.owner.query(`SELECT id,revision,sku_id,full_facts FROM public.catalog_sku_revisions
    WHERE sku_id=$1 ORDER BY revision`, [data.skuId]);
  expect(rows.rows).toEqual([first, second].map(entry => ({
    id: entry.skuRevisionId, revision: entry.revision, sku_id: data.skuId, full_facts: json(entry.facts),
  })));
  expect((await target.owner.query("SELECT publication_facts FROM public.catalog_products WHERE id=$1", [products[0]])).rows)
    .toEqual([{ publication_facts: null }]);
  expect((await target.owner.query(`SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1
    ORDER BY catalog_sku_revision_id NULLS LAST`, [subscription])).rows).toEqual([
    { catalog_sku_revision_id: first.skuRevisionId }, { catalog_sku_revision_id: null },
  ]);
  expect((await target.owner.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [order])).rows)
    .toEqual([{ catalog_acceptance: acceptance }]);
});
