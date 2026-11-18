import { expect, it } from "vitest";
import { createDbBackedCommerceQuotePort } from "../../src/pricing/index.js";
import { createPostgresCustomerOrderHistoryReadStore } from "../../src/account-support/postgresOrderHistory.js";
import { mapCustomerOrderLines } from "../../src/account-support/orderHistory.js";
import { nativeStockWaitDeficits } from "../../src/subscriptions/postgresStockWaitStore.js";
import type { RenewalFrozenSnapshotV3 } from "../../src/subscriptions/contracts/renewal.js";
import { asLegacyIntegralGrams } from "../../src/catalog/physicalQuantity.js";
import { productLdV2 } from "../../src/marketing/seo/jsonLd.js";
import { buildTypedProductPayload } from "../../src/fulfillment/omnipack/omnipackProductPayload.js";
import type { CatalogQuantity } from "../../src/catalog/contracts/productTypes.js";

import { createPostgresBundleCatalogStore } from "../../src/catalog/bundleCatalogStore.js";
import { createCatalogServingReader } from "../../src/catalog/servingRead.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import { compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import { input, registry, definition, rules } from "./fixtures/publicationInput.js";
import type { PgQueryExecutor } from "../../src/data/index.js";

const mass = { dimension: "mass", unit: "openlup:g", unscaled: "400", scale: 0 } as const;
const volume = { dimension: "volume", unit: "openlup:ml", unscaled: "50", scale: 0 } as const;
const count = { dimension: "count", unit: "openlup:piece", unscaled: "56", scale: 0 } as const;

it.each([
  ["MC5-D-001 grams", mass, 400],
  ["MC5-N-001 kilograms", { ...mass, unit: "openlup:kg", unscaled: "4", scale: 1 }, 400],
  ["MC5-N-001 fractional", { ...mass, unscaled: "4001", scale: 1 }, null],
  ["MC5-N-001 overflow", { ...mass, unscaled: "2147483648" }, null],
  ["MC5-N-001 volume", volume, null],
  ["MC5-N-001 count", count, null],
  ["MC5-N-001 zero", { ...mass, unscaled: "0" }, null],
] as const)("catalog_quantity_v2_and_legacy_boundary %s", (_rule, content, grams) => {
  expect(asLegacyIntegralGrams(content)).toEqual(grams === null ? { outcome: "quantity_requires_v2" } : { outcome: "converted", grams });
});

it.each<{ name: string; content: CatalogQuantity | null; expected: number | null }>([
  { name: "MC5-D-017 mass", content: mass, expected: 400 },
  { name: "MC5-D-017 volume", content: volume, expected: null },
  { name: "MC5-D-017 count", content: count, expected: null },
  { name: "MC5-N-007 absent", content: null, expected: null },
])("catalog_physical_destination_boundaries $name", ({ content, expected }) => {
  const origin = "https://example.invalid";
  const node = productLdV2(origin, { url: origin, name: "Article", inLanguage: "en", brandName: "Example", images: [], weight: content });
  if (expected === null) expect(node).not.toHaveProperty("weight");
  else expect(node).toHaveProperty("weight", { "@type": "QuantitativeValue", value: expected, unitCode: "GRM" });
});

it.each([
  ["MC5-D-029 explicit gross", { ...mass, unscaled: "120" }, 10, 120],
  ["MC5-D-029 missing gross", null, 10, "missing_pack"],
  ["MC5-D-029 wrong dimension", volume, 10, "invalid_pack_weight"],
  ["MC5-D-029 bad width", mass, 0, "invalid_pack_width"],
] as const)("catalog_physical_destination_boundaries %s", (_rule, grossMass, widthMm, expected) => {
  const project = () => buildTypedProductPayload({ sku: "ARTICLE", ean: "5901234123457", productGroup: "Example", title: "Article",
    pack: { grossMass, widthMm, lengthMm: 10, heightMm: 10 } });
  if (typeof expected === "number") expect(project()).toHaveProperty("dimensions.weight", expected);
  else expect(project).toThrow(expected);
});

const publicationId = "10000000-0000-4000-8000-000000000003";
const revisionId = "20000000-0000-4000-8000-000000000003";
const scope = { types: [{ key: definition.key, version: definition.version }], offerVersion: "example:offer" };

function reader(change: string, observed?: { revision: number; title: string; unavailable: boolean }) {
  const state = compileCatalogPublication(input());
  state.product.status = "active";
  const source = state.skus[0]!;
  if (change === "volume") source.netContent = volume;
  if (change === "count") source.netContent = count;
  source.status = "active";
  source.sellableStandalone = true;
  source.memberships = [{ offerVersion: scope.offerVersion, admitted: true }];
  const row: { id: string; publication_id: string | null; revision: number; sku_count: number } = { id: state.product.id, publication_id: publicationId, revision: 1, sku_count: 1 };
  const head = { publicationId, revision: 1, documentDigest: state.documents[0]!.reference.digest };
  const reference = { skuId: source.id, revisionId, revision: 1, digest: "a".repeat(64) };
  if (change === "head") head.revision++;
  if (change === "unadopted") row.publication_id = null;
  if (change === "overflow") row.sku_count++;
  if (change === "cardinality") row.sku_count++;
  if (change === "missing document") state.documents.length = 0;
  if (change === "missing primary") state.product.primarySkuId = "20000000-0000-4000-8000-000000000004";
  if (change === "missing GTIN") source.identifiers.length = 0;
  if (change === "unsellable") source.sellableStandalone = false;
  if (change === "withdrawn") source.status = "archived";
  const executor = {
    async query(sql: string) {
      if (sql.startsWith("SET TRANSACTION")) return { rows: [] };
      if (sql.includes("row_security_active")) {
        if (change === "outage" || observed?.unavailable) throw new Error("synthetic read failure");
        return { rows: [{ complete: change !== "restricted", definitions: [[definition.key, definition.version, catalogDefinitionDigest(definition)]] }] };
      }
      return { rows: change === "empty" ? [] : [observed ? { ...row, revision: observed.revision } : row] };
    },
  } as PgQueryExecutor;
  return createCatalogServingReader({
    transactions: { run: work => work(executor) }, registry, rules,
    authorizeHuman: async () => ({ ok: false }), readiness: async () => ({ ready: false, reasons: [] }),
    verifyMedia: async () => false,
  }, async () => {
    if (observed) { head.revision = observed.revision; source.title = observed.title; }
    return { ...state, head, references: [reference] };
  }, {
    ...scope, ...(change === "overflow" ? { maxItems: 1 } : {}),
  });
}

const servingPaths = ["listing", "detail", "quote", "editor"] as const;
function readPath(path: typeof servingPaths[number], port: ReturnType<typeof reader>) {
  if (path === "listing") return port.list({ cursor: null, limit: 1 }).then(page => page.items);
  if (path === "detail") return port.detail("article").then(page => page.items);
  if (path === "quote") return port.listQuoteCatalogItems();
  return port.listEditorSkus();
}

const readFailures = [
  ["MC5-D-005", "head", "catalog_authority_changed"],
  ["MC5-D-020", "cardinality", "catalog_authority_changed"],
  ["MC5-D-007", "missing document", "catalog_document_schema_invalid"],
  ["MC5-D-046", "missing primary", "catalog_primary_trade_item_invalid"],
  ["MC5-D-047", "missing GTIN", "catalog_primary_trade_item_invalid"],
  ["MC5-D-019", "restricted", "catalog_authority_unavailable"],
  ["MC5-D-006", "outage", "catalog_authority_unavailable"],
  ["MC5-D-005", "overflow", "catalog_cardinality_exceeded"],
  ["MC5-D-021", "unadopted", "catalog_authority_unsupported"],
] as const;

it.each(servingPaths.flatMap(path => readFailures.map(([rule, change, code]) => ({ path, rule, change, code }))))(
  "catalog_authoritative_page_and_projection $rule $path $change", async ({ path, change, code }) => {
    await expect(readPath(path, reader(change))).rejects.toMatchObject({ code });
  },
);

it.each(servingPaths.flatMap(path => ["empty", "withdrawn", "unsellable", "current"].map(change => ({ path, change }))))(
  "catalog_authoritative_page_and_projection MC5-D-019 MC5-D-047 $path $change", async ({ path, change }) => {
    const items = await readPath(path, reader(change));
    if (change === "current" || change === "unsellable" && path === "listing") {
      expect(items).toHaveLength(1);
      expect(items[0]?.acceptedReference).toMatchObject({ publicationHead: { publicationId, revision: 1 }, skuRevisionId: revisionId });
    } else expect(items).toEqual([]);
  },
);

it.each([
  ["invalid cursor", "%%%invalid", 1, "catalog_cursor_invalid"],
  ["invalid limit", null, 501, "catalog_cursor_invalid"],
  ["old version", Buffer.from(JSON.stringify(["c".repeat(64), publicationId])).toString("base64url"), 1, "catalog_authority_changed"],
] as const)("catalog_authoritative_page_and_projection MC5-D-018 %s", async (_name, cursor, limit, code) => {
  await expect(reader("current").list({ cursor, limit })).rejects.toMatchObject({ code });
});

it("catalog_pdp_reads_new_publication_without_rebuild MC5-N-004", async () => {
  const observed = { revision: 1, title: "First", unavailable: false };
  const port = reader("current", observed);
  const first = await port.detail("article");
  expect(first.items[0]?.sku.title).toBe("First");
  observed.revision = 2;
  observed.title = "Second";
  const second = await port.detail("article");
  expect(second.items[0]?.sku.title).toBe("Second");
  expect(second.version).not.toBe(first.version);
  const productId = second.items[0]!.product.id;
  port.invalidateProduct(productId);
  port.invalidateProduct(productId);
  expect(await port.detail("article")).toEqual(second);
  observed.unavailable = true;
  await expect(port.detail("article")).rejects.toMatchObject({ code: "catalog_authority_unavailable" });
});

it("catalog_volume_quotes_without_gram_coercion MC5-N-001", async () => {
  const port = reader("volume");
  const [observed] = await port.listQuoteCatalogItems();
  expect(observed?.netContent).toEqual(volume);
  expect(observed).not.toHaveProperty("netWeightG");
  const taxProfile = { included: true as const, country: "ZZ", vatRateBps: 0, category: "standard", legalBasis: "Fictional" };
  const quote = createDbBackedCommerceQuotePort({
    quoteCatalogReadPort: port,
    isStrictD1Quote: true,
    commercePriceAuthorityPort: {
      async resolvePrice(query) {
        return { kind: "one_time", unitPriceMinor: 1490, base: {
          variantId: query.variantId, mode: "one_time", matchedMinQty: 1, unitPriceMinor: 1490, amountKind: "gross",
          priceListId: publicationId, priceEntryId: revisionId,
        } };
      },
    },
    taxProfile, supportedTaxProfiles: [taxProfile], regionCode: "ZZ", currency: "XXX",
    now: () => "2030-01-01T00:00:00Z", hasPromotionCodePort: false,
    lineContext(_line, item) {
      expect(item.netContent).toEqual(volume);
      expect(item.acceptedReference.skuRevisionId).toBe(revisionId);
      return {};
    },
    quoteContext: request => () => ({ mode: request.mode, cadenceDays: null, promoCodes: [] }),
    resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: async () => ({ discounts: [], codeRejections: [], codeRejectionDetails: [] }),
  });
  const snapshot = await quote.createServerAuthoritativeQuote({ mode: "one_time", lines: [{ sku: "ARTICLE", quantity: 2 }], promoCodes: [] });
  expect(snapshot.quote.lines).toMatchObject([{ quantity: 2, unitPriceGross: { amountMinor: 1490 }, lineSubtotalGross: { amountMinor: 2980 } }]);
});

it.each([
  ["MC5-N-007 old quantity absent", null],
  ["MC5-D-027 typed volume", volume],
  ["MC5-D-028 typed count", count],
] as const)("catalog_retained_quantity_display %s", async (_rule, typedContent) => {
  const db = { query: async () => ({ rows: [{ id: publicationId, sku: "ARTICLE", title: "Retained label" }] }) };
  const deficits = [{ sku: "ARTICLE", requiredUnits: 2, reservedUnits: 0, availableUnits: 1, missingUnits: 1 }];
  const [item] = await reader("current").listQuoteCatalogItems();
  const accepted = { ...item!.acceptedReference, skuId: publicationId, netContent: typedContent ?? mass };
  const snapshot = typedContent ? {
    frozenRevision: "native.purchase-renewal.v3", catalogAcceptance: { schemaVersion: 2, lines: [accepted] },
  } as RenewalFrozenSnapshotV3 : undefined;
  const stock = await nativeStockWaitDeficits(db, deficits, snapshot);
  const physical = typedContent ? { netContent: typedContent } : {};
  expect(stock).toEqual([{ ...physical, skuId: publicationId, sku: "ARTICLE", displayName: "Retained label",
    size: null, required: 2, available: 1, reserved: 0, missing: 1 }]);
  const order = mapCustomerOrderLines([{
    id: revisionId, sku_id: publicationId, quantity: 2, unit_price_cents: 1490, total_cents: 2980,
  }], [], "XXX", { display: () => ({ title: "Retained label", variantName: null }) });
  expect(order).toEqual([{ lineId: revisionId, skuId: publicationId, title: "Retained label", variantName: null,
    quantity: 2, unitPrice: { amountMinor: 1490, currency: "XXX" }, total: { amountMinor: 2980, currency: "XXX" },
    listTotal: null, discount: null }]);
  const retained = createPostgresCustomerOrderHistoryReadStore({
    async query(sql, inputs) {
      expect(sql).toContain("JOIN owned_orders");
      expect(inputs).toEqual([publicationId, revisionId, revisionId]);
      return { rows: [{ row: { id: revisionId, sku_id: publicationId, net_content: typedContent } }] };
    },
  }, { principalId: publicationId, clientId: revisionId, readInvoiceSummaries: async () => new Map() });
  expect(await retained.readRetainedLineContent(revisionId)).toEqual(typedContent
    ? [{ lineId: revisionId, skuId: publicationId, netContent: typedContent }] : []);
});

it.each([
  ["MC5-N-002 count", count, true],
  ["MC5-N-002 volume", volume, true],
  ["MC5-N-002 incomplete count", { ...count, scale: 1 }, false],
  ["MC5-N-002 mismatched unit", { ...count, unit: volume.unit }, false],
  ["MC5-D-014 unknown", null, false],
] as const)("catalog_bundle_content_only_boundary %s", async (_case, typed_content, visible) => {
  const read = createPostgresBundleCatalogStore({
    async query(sql: string) {
      if (sql.includes("FROM unnest")) return { rows: [{
        variant_id: revisionId, bundle_id: publicationId, sku: "ARTICLE", title: null, product_slug: "article",
        sku_status: "active", product_status: "active", document_ready: true,
        identifiers: [{ isPrimary: true, packKind: "unit", kind: "gtin", packQuantity: 1, normalizedValue: "5901234123457" }],
        typed_content, net_weight_g: null, sellable_standalone: true,
        quantity: 2, sort_order: 0, reference_unit_price_minor: 542, reference_price_count: 1,
      }] };
      if (sql.includes("FROM public.catalog_bundles b")) return { rows: [{
        id: publicationId, code: "SET", title: "Set", fulfillment_mode: "virtual", currency: "XXX", region_code: "ZZ",
        mode: "one_time", target_price_minor: 713, price_list_id: revisionId,
      }] };
      return { rows: [{ id: revisionId }] };
    },
  }, { priceAuthority: "effective" });
  const result = await read.listActiveBundleCompositions({ currency: "XXX", regionCode: "ZZ", atTime: "2030-01-01T00:00:00Z" });
  if (visible) expect(result).toMatchObject([{ targetPriceMinor: 713, components: [{ quantity: 2, referenceUnitPriceMinor: 542 }] }]);
  else expect(result).toEqual([]);
});

it("neutral_listing_does_not_require_ingredients MC5-N-003", async () => {
  const { items } = await reader("count").list({ cursor: null, limit: 100 });
  expect(items).toMatchObject([{ product: { title: "Synthetic article", type: scope.types[0] }, sku: { netContent: count } }]);
});
