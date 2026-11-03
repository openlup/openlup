/** Characterizes current-document quote facts and closed refusals on PostgreSQL. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { PgQueryExecutor } from "@openlup/platform/data";
import type { CommerceQuoteCatalogReadRefusalCode } from "@openlup/platform/pricing";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { createQuoteCatalogFixture, digest, documentFor, seed } from "./commerceQuoteCatalogFixture.js";

let fixture: Awaited<ReturnType<typeof createQuoteCatalogFixture>>;
const extra = seed.skus[500]!;
const make = (executor: PgQueryExecutor = fixture.executor, maxItems?: number) => fixture.catalog.createPostgresCommerceQuoteCatalogReadPort(executor, { maxItems, verifyDocument: fixture.verifyDocument });
const isPayload = (sql: string) => sql.includes("revision_document_payload");
const isIdentifiers = (sql: string) => sql.includes("FROM public.catalog_sku_identifiers");
const isPage = (sql: string) => sql.includes("sku.status = 'active'");
function intercept(transform: (rows: Record<string, unknown>[], sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]> | Record<string, unknown>[]) {
  return { async query(sql: string, values?: unknown[]) {
    const result = await fixture.executor.query(sql, values);
    return { rows: await transform(result.rows, sql, values) };
  } };
}
async function refusal(port: ReturnType<typeof make>, code: CommerceQuoteCatalogReadRefusalCode) {
  const result = await port.listQuoteCatalogItems().then(value => ({ value }), error => ({ error }));
  expect(result).toHaveProperty("error");
  const error = (result as { error: unknown }).error;
  expect(error).toBeInstanceOf(fixture.pricing.CommerceQuoteCatalogReadError);
  expect(error).toMatchObject({ code, message: code });
  expect(JSON.stringify(error)).not.toContain("private details");
}
async function update(sql: string, values: unknown[], work: () => Promise<void>, restore: string, restoreValues = values) {
  await fixture.owner.query(sql, values);
  try { await work(); } finally { await fixture.owner.query(restore, restoreValues); }
}

beforeAll(async () => {
  fixture = await createQuoteCatalogFixture();
  await fixture.owner.query("UPDATE public.catalog_skus SET status='archived' WHERE id=$1", [extra.id]);
}, postgresSetupTimeoutMs);
afterAll(async () => { await fixture?.close(); }, postgresTeardownTimeoutMs);

it("reads exactly 500 facts in UUID order, using pages of 100 and deduped payload batches", async () => {
  const calls: { sql: string; values?: unknown[]; rows: Record<string, unknown>[] }[] = [];
  const verifyDocument = vi.fn(fixture.verifyDocument);
  const db = intercept((rows, sql, values) => { calls.push({ rows, sql, values }); return isPayload(sql) ? [...rows].reverse() : rows; });
  const items = await fixture.catalog.createPostgresCommerceQuoteCatalogReadPort(db, { verifyDocument }).listQuoteCatalogItems();
  expect(items).toHaveLength(500);
  const expectedSkus = seed.skus.slice(0, 500).sort((a, b) => a.id.localeCompare(b.id));
  expect(items.map(item => item.skuId)).toEqual(expectedSkus.map(sku => sku.id));
  for (const item of items) {
    const index = seed.skus.findIndex(sku => sku.id === item.skuId), sku = seed.skus[index]!;
    expect(item).toEqual({ skuId: sku.id, skuCode: sku.sku, variantId: sku.id, productSlug: seed.products[index]!.slug,
      netWeightG: index + 1, isPrimarySku: true, isAddon: false,
      sellability: { oneTime: sku.sellable_standalone, subscription: sku.sellable_in_subscription },
      documentRevision: { id: expect.any(String), digest: digest(documentFor(index)) } });
  }
  const pages = calls.filter(call => isPage(call.sql)), payloads = calls.filter(call => isPayload(call.sql));
  expect(pages).toHaveLength(5); expect(payloads).toHaveLength(5);
  expect(calls.filter(call => isIdentifiers(call.sql))).toHaveLength(5);
  expect(pages[0]!.values).toEqual([null, 101, null]);
  for (const [index, call] of pages.entries()) {
    expect(call.values).toEqual([index === 0 ? null : expectedSkus[index * 100 - 1]!.id, 101, null]);
    expect(payloads[index]!.values).toEqual([expectedSkus.slice(index * 100, (index + 1) * 100).map(sku => sku.product_id)]);
  }
  expect(verifyDocument).toHaveBeenCalledTimes(500);
  expect(verifyDocument).toHaveBeenCalledWith(documentFor(0), expect.objectContaining({ sku: expect.objectContaining({ id: seed.skus[0]!.id }) }));
});

it("excludes inactive and unsellable SKUs, validates inactive products before exclusion, and retains secondary/addon facts", async () => {
  const db = fixture.owner;
  await db.query("UPDATE public.catalog_skus SET status='draft' WHERE id=$1", [seed.skus[0]!.id]);
  await db.query("UPDATE public.catalog_skus SET sellable_standalone=false,sellable_in_subscription=false WHERE id=$1", [seed.skus[1]!.id]);
  await db.query("UPDATE public.catalog_products SET status='archived' WHERE id=$1", [seed.products[2]!.id]);
  // A secondary SKU uses an already owned seed row; no alternate business seed.
  await db.query("UPDATE public.catalog_products SET primary_sku_id=NULL WHERE id=$1", [seed.products[3]!.id]);
  await db.query("UPDATE public.catalog_skus SET product_id=$2,is_addon=true WHERE id=$1", [seed.skus[3]!.id, seed.products[4]!.id]);
  try {
    // Current provenance is checked before exclusion; opaque payload verification follows it.
    const verifyDocument = vi.fn(fixture.verifyDocument);
    const malformedInactive = intercept((rows, sql) => isPayload(sql) ? rows.map(row => row.product_id === seed.products[2]!.id
      ? { ...row, revision_document_payload: null } : row) : rows);
    const items = await fixture.catalog.createPostgresCommerceQuoteCatalogReadPort(malformedInactive, { verifyDocument }).listQuoteCatalogItems();
    expect(items).toHaveLength(497);
    expect(verifyDocument).toHaveBeenCalledTimes(497);
    expect(verifyDocument).not.toHaveBeenCalledWith(null, expect.anything());
    for (const sku of seed.skus.slice(0, 3)) expect(items.map(item => item.skuId)).not.toContain(sku.id);
    expect(items.find(item => item.skuId === seed.skus[3]!.id)).toMatchObject({ productSlug: seed.products[4]!.slug, isPrimarySku: false, isAddon: true });
    await update("UPDATE public.catalog_products SET current_document_revision_id=NULL WHERE id=$1", [seed.products[2]!.id],
      () => refusal(make(), "catalog_revision_invalid"),
      "UPDATE public.catalog_products SET current_document_revision_id=(SELECT id FROM public.catalog_product_document_revisions WHERE product_id=$1 AND revision_no=1) WHERE id=$1");
  } finally {
    await db.query("UPDATE public.catalog_skus SET status='active' WHERE id=$1", [seed.skus[0]!.id]);
    await db.query("UPDATE public.catalog_skus SET sellable_standalone=$2,sellable_in_subscription=$3 WHERE id=$1", [seed.skus[1]!.id, seed.skus[1]!.sellable_standalone, seed.skus[1]!.sellable_in_subscription]);
    await db.query("UPDATE public.catalog_products SET status='active' WHERE id=$1", [seed.products[2]!.id]);
    await db.query("UPDATE public.catalog_skus SET product_id=$2,is_addon=false WHERE id=$1", [seed.skus[3]!.id, seed.products[3]!.id]);
    await db.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [seed.products[3]!.id, seed.skus[3]!.id]);
  }
});

it("allows exactly a configured maximum, refuses one excess without partial success, and bounds empty filtered pages", async () => {
  await update("UPDATE public.catalog_skus SET status='active' WHERE id=$1", [extra.id], async () => {
    await refusal(make(), "catalog_cardinality_exceeded");
    expect(await make(fixture.executor, 501).listQuoteCatalogItems()).toHaveLength(501);
  }, "UPDATE public.catalog_skus SET status='archived' WHERE id=$1");
  expect(await make(fixture.executor, 500).listQuoteCatalogItems()).toHaveLength(500);
  await refusal(make(fixture.executor, 499), "catalog_cardinality_exceeded");
  const filtered = intercept((rows, sql) => isPayload(sql) ? rows.map(row => ({ ...row, product_status: "archived" })) : rows);
  // max1 admits at most two pages, even when every product is filtered out.
  await refusal(make(filtered, 1), "catalog_cardinality_exceeded");
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses invalid technical maximum %s", maxItems => {
  expect(() => make(fixture.executor, maxItems)).toThrow(RangeError);
});
it("refuses a missing verifier instead of trusting opaque JSON", () => {
  for (const options of [undefined, {}, { verifyDocument: null }]) {
    expect(() => fixture.catalog.createPostgresCommerceQuoteCatalogReadPort(fixture.executor, options as never)).toThrow(
      new fixture.pricing.CommerceQuoteCatalogReadError("catalog_read_not_configured"));
  }
});

it.each([
  ["product absent", "catalog_authority_changed", (row: Record<string, unknown>) => ({ ...row, product_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" })],
  ["slug moved", "catalog_authority_changed", (row: Record<string, unknown>) => ({ ...row, product_slug: "moved" })],
  ["pointer moved", "catalog_authority_changed", (row: Record<string, unknown>) => ({ ...row, current_document_revision_id: null })],
  ["revision missing", "catalog_revision_invalid", (row: Record<string, unknown>) => ({ ...row, revision_id: null })],
  ["revision id", "catalog_revision_invalid", (row: Record<string, unknown>) => ({ ...row, revision_id: seed.skus[0]!.id })],
  ["revision product", "catalog_revision_invalid", (row: Record<string, unknown>) => ({ ...row, revision_product_id: extra.product_id })],
  ["revision number", "catalog_revision_invalid", (row: Record<string, unknown>) => ({ ...row, revision_no: 99 })],
  ["revision schema", "catalog_revision_invalid", (row: Record<string, unknown>) => ({ ...row, revision_schema_id: "unexpected" })],
  ["revision digest", "catalog_revision_invalid", (row: Record<string, unknown>) => ({ ...row, revision_digest: "b".repeat(64) })],
  ["invalid lifecycle", "catalog_revision_invalid", (row: Record<string, unknown>) => ({ ...row, product_status: "unexpected" })],
] as const)("refuses guarded payload %s before calling the verifier", async (_name, code, change) => {
  const verifier = vi.fn(fixture.verifyDocument);
  const db = intercept((rows, sql) => isPayload(sql) ? rows.map(row => change(row)) : rows);
  await refusal(fixture.catalog.createPostgresCommerceQuoteCatalogReadPort(db, { verifyDocument: verifier }), code);
  expect(verifier).not.toHaveBeenCalled();
});
it("refuses duplicate joined product rows", async () => {
  await refusal(make(intercept((rows, sql) => isPayload(sql) ? [...rows, ...rows] : rows)), "catalog_revision_invalid");
});

it("detects a real pointer change between envelope/identifier read and guarded payload SELECT", async () => {
  const product = seed.products[0]!;
  const original = (await fixture.owner.query("SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1", [product.id])).rows[0]!.current_document_revision_id;
  const document = documentFor(0, 2);
  const next = (await fixture.owner.query(`INSERT INTO public.catalog_product_document_revisions
    (product_id,revision_no,schema_id,document_ref,document_payload,provenance,source_ref,digest)
    VALUES($1,2,$2,$3,$4,'{}','fixture:replacement',$5) RETURNING id`, [product.id, document.schemaVersion, document.id, document, digest(document)])).rows[0]!.id;
  let moved = false;
  const db = { async query(sql: string, values?: unknown[]) {
    if (isPayload(sql) && !moved && (values?.[0] as string[]).includes(product.id)) {
      moved = true;
      await fixture.owner.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [product.id, next]);
    }
    return fixture.executor.query(sql, values);
  } };
  try { await refusal(make(db), "catalog_authority_changed"); expect(moved).toBe(true); }
  finally { await fixture.owner.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [product.id, original]); }
});

it.each(["schema", "semantic identity", "digest"])("lets the host refuse document %s using the shared error class", async kind => {
  const db = intercept((rows, sql) => {
    if (!isPayload(sql)) return rows;
    return rows.map(row => ({ ...row, revision_document_payload: { ...(row.revision_document_payload as object),
      ...(kind === "schema" ? { schemaVersion: "unsupported" } : kind === "semantic identity" ? { productSlug: "wrong" } : { extension: "changed" }) } }));
  });
  await refusal(make(db), kind === "digest" ? "catalog_document_digest_mismatch" : "catalog_document_schema_invalid");
});
it("forwards an arbitrary typed host refusal unchanged and maps an untyped host error safely", async () => {
  const error = new fixture.pricing.CommerceQuoteCatalogReadError("catalog_document_digest_mismatch");
  const port = fixture.catalog.createPostgresCommerceQuoteCatalogReadPort(fixture.executor, { verifyDocument: async () => { throw error; } });
  await expect(port.listQuoteCatalogItems()).rejects.toBe(error);
  await refusal(fixture.catalog.createPostgresCommerceQuoteCatalogReadPort(fixture.executor, { verifyDocument: async () => { throw new Error("private details"); } }), "catalog_authority_unavailable");
});

it.each([
  ["missing primary SKU", "catalog_primary_trade_item_invalid", (row: Record<string, unknown>) => ({ ...row, primary_sku_id: null })],
  ["missing current revision", "catalog_revision_invalid", (row: Record<string, unknown>) => ({ ...row, current_document_revision_id: null })],
  ["zero weight", "catalog_authority_unavailable", (row: Record<string, unknown>) => ({ ...row, net_content_unscaled: 0 })],
] as const)("maps strict envelope %s", async (_name, code, change) => {
  await refusal(make(intercept((rows, sql) => isPage(sql) ? rows.map(row => change(row)) : rows)), code);
});
it.each(["absent", "invalid", "ambiguous"])("refuses %s primary unit facts", async kind => {
  const db = intercept((rows, sql) => !isIdentifiers(sql) ? rows : kind === "absent" ? [] : kind === "invalid"
    ? rows.map(row => ({ ...row, normalized_value: "invalid" })) : [...rows, ...rows]);
  await refusal(make(db), "catalog_primary_trade_item_invalid");
});
it.each(["duplicate variant", "duplicate code"])("refuses %s instead of silently overwriting", async kind => {
  const db = intercept((rows, sql) => {
    if (!isPage(sql)) return rows;
    if (kind === "duplicate variant") return [rows[0]!, ...rows];
    return rows.map(row => ({ ...row, sku_code: "opaque:duplicate.v1" }));
  });
  await refusal(make(db), "catalog_authority_changed");
});
it("refuses a repeated keyset cursor from a faulty executor", async () => {
  let first: Record<string, unknown>[] | undefined;
  const db = intercept((rows, sql) => {
    if (isPage(sql)) { first ??= rows; return first; }
    return isPayload(sql) ? rows.map(row => ({ ...row, product_status: "archived" })) : rows;
  });
  await refusal(make(db), "catalog_cursor_invalid");
});
it.each(["page", "identifiers", "payload"])("never returns [] after a failing %s executor", async phase => {
  const db = { async query(sql: string, values?: unknown[]) {
    if (phase === "page" && isPage(sql) || phase === "identifiers" && isIdentifiers(sql) || phase === "payload" && isPayload(sql)) throw new Error("private details");
    return fixture.executor.query(sql, values);
  } };
  await refusal(make(db), "catalog_authority_unavailable");
});
it("reads afresh on repeated calls without process or factory caching", async () => {
  const query = vi.fn(fixture.executor.query);
  const port = make({ query });
  expect(await port.listQuoteCatalogItems()).toHaveLength(500);
  const count = query.mock.calls.length;
  expect(count).toBe(15);
  expect(await port.listQuoteCatalogItems()).toHaveLength(500);
  expect(query).toHaveBeenCalledTimes(count * 2);
});
it("uses only existing runtime SELECT authority and leaves all catalog rows unchanged", async () => {
  const snapshot = async () => Promise.all(["catalog_products", "catalog_skus", "catalog_product_document_revisions", "catalog_sku_identifiers"].map(async table =>
    (await fixture.owner.query(`SELECT to_jsonb(row) AS row FROM public.${table} row ORDER BY row.id`)).rows));
  const before = await snapshot();
  expect(await make().listQuoteCatalogItems()).toHaveLength(500);
  expect(await snapshot()).toEqual(before);
  const identity = await fixture.executor.query("SELECT session_user AS login,current_user AS role");
  expect(identity.rows).toEqual([{ login: "quote_catalog_runtime", role: "service_role" }]);
  const client = await fixture.runtime.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL ROLE service_role");
    await expect(client.query("UPDATE public.catalog_products SET status=status")).rejects.toMatchObject({ code: "42501" });
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it("requires host schema admission even when the full revision tuple agrees", async () => {
  const db = intercept((rows, sql) => isPage(sql) ? rows.map(row => ({ ...row, document_schema_id: "unsupported" }))
    : isPayload(sql) ? rows.map(row => ({ ...row, revision_schema_id: "unsupported" })) : rows);
  await refusal(make(db), "catalog_document_schema_invalid");
});
it("refuses incomplete primary facts and nonpositive grams stored by the installation owner", async () => {
  await update("UPDATE public.catalog_sku_identifiers SET is_primary=false WHERE catalog_sku_id=$1", [seed.skus[0]!.id],
    () => refusal(make(), "catalog_primary_trade_item_invalid"),
    "UPDATE public.catalog_sku_identifiers SET is_primary=true WHERE catalog_sku_id=$1");
  await update("UPDATE public.catalog_skus SET net_weight_g=0 WHERE id=$1", [seed.skus[0]!.id],
    () => refusal(make(), "catalog_authority_unavailable"),
    "UPDATE public.catalog_skus SET net_weight_g=1 WHERE id=$1");
});
it("does not return earlier pages when a later page fails", async () => {
  let pages = 0;
  const db = { async query(sql: string, values?: unknown[]) {
    if (isPage(sql) && ++pages === 2) throw new Error("private details");
    return fixture.executor.query(sql, values);
  } };
  await refusal(make(db), "catalog_authority_unavailable");
  expect(pages).toBe(2);
});
it.each([
  ["catalog_sku_authority_sku_absent", "catalog_revision_invalid"],
  ["catalog_sku_authority_product_absent", "catalog_revision_invalid"],
  ["catalog_sku_authority_primary_sku_invalid", "catalog_primary_trade_item_invalid"],
  ["catalog_sku_authority_selector_ambiguous", "catalog_revision_invalid"],
  ["catalog_sku_authority_current_document_absent", "catalog_revision_invalid"],
  ["catalog_sku_authority_current_document_invalid", "catalog_revision_invalid"],
  ["catalog_sku_identifier_authority_absent", "catalog_primary_trade_item_invalid"],
  ["catalog_sku_identifier_authority_ambiguous", "catalog_primary_trade_item_invalid"],
  ["catalog_sku_identifier_authority_invalid", "catalog_primary_trade_item_invalid"],
] as const)("maps the existing authority error %s to %s", async (source, target) => {
  await refusal(make({ query: async () => { throw new fixture.catalog.CatalogSkuAuthorityError(source); } }), target);
});
