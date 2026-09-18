import { describe, expect, it } from "vitest";
import { catalogDraftPayloadSchema, type CatalogDraftPayload } from "../../../src/domains/catalog/catalogDraftContracts.js";
import { createCatalogProductTypeRegistry } from "../../../src/domains/catalog/catalogProductTypeContracts.js";
import { validateCatalogDraft } from "./catalogDraftValidation.js";

const productId = "10000000-0000-4000-8000-000000000001";
const skuId = "20000000-0000-4000-8000-000000000001";
const registry = createCatalogProductTypeRegistry([{
  key: "example:article", version: 1,
  units: [{ code: "item:piece", dimension: "count", integral: true }, { code: "si:gram", dimension: "mass", integral: false }],
  netContentUnits: ["item:piece"], dimensions: [
    { key: "finish", kind: "choice", values: ["matte", "gloss"] },
    { key: "size", kind: "quantity", dimension: "count", units: ["item:piece"] },
  ], validateContent: (value) => typeof value === "object" && value !== null && "title" in value && typeof value.title === "string" ? [] : [{ path: "title", code: "title_invalid" }],
}]);
function payload(): CatalogDraftPayload {
  return catalogDraftPayloadSchema.parse({ schemaVersion: 1,
    product: { id: productId, type: { key: "example:article", version: 1 }, dimensions: ["finish", "size"], sharedContent: { title: "A" } },
    skus: [{ id: skuId, productId, options: {} }],
  });
}
const size = { kind: "quantity" as const, value: { dimension: "count" as const, unit: "item:piece", unscaled: "1", scale: 0 } };
function codes(value: CatalogDraftPayload): string[] {
  const result = validateCatalogDraft(value, registry);
  return result.valid ? [] : result.issues.map(({ code }) => code);
}

describe("draft validity and readiness", () => {
  it("accepts missing fields and zero SKUs, with separate non-activation evidence", () => {
    const empty = payload(); empty.skus = []; delete empty.product.sharedContent;
    const result = validateCatalogDraft(empty, registry);
    expect(result).toMatchObject({ valid: true, readiness: { publication: { status: "incomplete" }, commercial: { status: "inactive" } } });
    const partial = validateCatalogDraft(payload(), registry);
    expect(partial.valid && partial.readiness.publication.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(["primary_sku_missing", "net_content_missing", "option_missing"]));
  });
  it("accepts two incomplete combinations but refuses duplicate completed combinations", () => {
    const value = payload(); value.skus.push({ ...value.skus[0], id: "20000000-0000-4000-8000-000000000002" });
    expect(codes(value)).toEqual([]);
    value.skus.forEach((sku) => { sku.options = { finish: { kind: "choice", value: "matte" }, size }; });
    value.skus[1].options.size = { ...size, value: { ...size.value, unscaled: "100", scale: 2 } };
    expect(codes(value)).toContain("duplicate_option_combination");
    value.skus[1].options.finish = { kind: "choice", value: "gloss" };
    expect(codes(value)).toEqual([]);
  });
  it("has exactly one complete empty combination when no dimensions are declared", () => {
    const value = payload(); value.product.dimensions = [];
    value.skus.push({ ...value.skus[0], id: "20000000-0000-4000-8000-000000000002" });
    expect(codes(value)).toContain("duplicate_option_combination");
  });
  it("refuses unknown versions, malformed content and typed option mismatches", () => {
    const value = payload(); value.product.type.version = 2;
    expect(codes(value)).toContain("type_not_installed");
    value.product.type.version = 1; value.product.sharedContent = { title: 12 };
    expect(codes(value)).toContain("title_invalid");
    delete value.product.sharedContent;
    value.skus[0].options = { finish: { kind: "boolean", value: true }, other: size };
    expect(codes(value)).toEqual(expect.arrayContaining(["option_type_invalid", "dimension_not_declared"]));
    value.skus[0].options = { finish: { kind: "choice", value: "missing" }, size: { ...size, value: { ...size.value, scale: 1 } } };
    expect(codes(value)).toEqual(expect.arrayContaining(["option_value_invalid", "option_quantity_invalid"]));
  });
  it("rejects foreign ownership, invalid units, duplicate identifiers and invalid GTIN", () => {
    const value = payload(); const sku = value.skus[0];
    sku.productId = skuId;
    sku.netContent = { ...size.value, dimension: "mass" };
    sku.grossMass = size.value;
    sku.identifiers = [0, 1].map(() => ({ scheme: "gs1:gtin", issuer: "gs1", value: "123", packagingLevel: "unit" }));
    expect(codes(value)).toEqual(expect.arrayContaining(["foreign_product_reference", "net_content_invalid", "gross_mass_invalid", "duplicate_trade_identifier", "trade_identifier_invalid"]));
  });
  it("never treats supplied commercial references as sale authority", () => {
    const value = payload(); Object.assign(value.product, { slug: "article", primarySkuId: skuId });
    Object.assign(value.skus[0], { code: "A", options: { finish: { kind: "choice", value: "matte" }, size }, netContent: size.value, priceRef: "price:1", logisticsRef: "shipping:1" });
    expect(validateCatalogDraft(value, registry)).toMatchObject({ valid: true, readiness: { publication: { status: "not_assessed", issues: [] }, commercial: { status: "inactive", issues: expect.arrayContaining([{ path: "skus", code: "commercial_activation_not_assessed" }]) } } });
  });
});
