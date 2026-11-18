import { expect, it } from "vitest";
import { asLegacyIntegralGrams } from "../../src/catalog/physicalQuantity.js";
import { productLdV2 } from "../../src/marketing/seo/jsonLd.js";
import { buildOmnipackProductPayloadV2 } from "../../src/fulfillment/omnipack/omnipackProductPayload.js";
import type { CatalogQuantity } from "../../src/catalog/contracts/productTypes.js";

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
  const project = () => buildOmnipackProductPayloadV2({ sku: "ARTICLE", ean: "5901234123457", productGroup: "Example", title: "Article",
    pack: { grossMass, widthMm, lengthMm: 10, heightMm: 10 } });
  if (typeof expected === "number") expect(project()).toHaveProperty("dimensions.weight", expected);
  else expect(project).toThrow(expected);
});

import { createCatalogServingReader } from "../../src/catalog/servingRead.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import { compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import { input, registry, definition, rules } from "./fixtures/publicationInput.js";
import type { PgQueryExecutor } from "../../src/data/index.js";

const publicationId = "10000000-0000-4000-8000-000000000003";
const revisionId = "20000000-0000-4000-8000-000000000003";
const scope = { types: [{ key: definition.key, version: definition.version }], offerVersion: "example:offer" };

function reader(change: string) {
  const state = compileCatalogPublication(input());
  state.product.status = "active";
  const source = state.skus[0]!;
  source.status = "active";
  source.sellableStandalone = true;
  source.memberships = [{ offerVersion: scope.offerVersion, admitted: true }];
  const row = { id: state.product.id, publication_id: publicationId, revision: 1, sku_count: 1 };
  const head = { publicationId, revision: 1, documentDigest: state.documents[0]!.reference.digest };
  const reference = { skuId: source.id, revisionId, revision: 1, digest: "a".repeat(64) };
  if (change === "head") head.revision++;
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
        if (change === "outage") throw new Error("synthetic read failure");
        return { rows: [{ complete: change !== "restricted", definitions: [[definition.key, definition.version, catalogDefinitionDigest(definition)]] }] };
      }
      return { rows: change === "empty" ? [] : [row] };
    },
  } as PgQueryExecutor;
  return createCatalogServingReader({
    transactions: { run: work => work(executor) }, registry, rules,
    authorizeHuman: async () => ({ ok: false }), readiness: async () => ({ ready: false, reasons: [] }),
    verifyMedia: async () => false,
  }, async () => ({ ...state, head, references: [reference] }), {
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
