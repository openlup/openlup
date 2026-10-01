import { describe, expect, it } from "vitest";
import { catalogDraftPayloadSchema, type CatalogDraftPayload } from "../../../src/domains/catalog/catalogDraftContracts.js";
import { createCatalogProductTypeRegistry, type CatalogQuantity } from "../../../src/domains/catalog/catalogProductTypeContracts.js";
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

const packRegistry = createCatalogProductTypeRegistry([{
  key: "example:article", version: 2,
  units: [{ code: "item:piece", dimension: "count", integral: true }, { code: "item:dozen", dimension: "count", integral: true }],
  netContentUnits: ["item:piece", "item:dozen"],
  dimensions: [{ key: "pack", kind: "quantity", dimension: "count", units: ["item:piece", "item:dozen"], role: "net_content" }],
  validateContent: () => [],
}]);
const count = (unscaled: string, scale = 0, unit = "item:piece"): CatalogQuantity => ({ dimension: "count", unit, unscaled, scale });
function packed(option: CatalogQuantity, netContent: CatalogQuantity): CatalogDraftPayload {
  return catalogDraftPayloadSchema.parse({ schemaVersion: 1,
    product: { id: productId, type: { key: "example:article", version: 2 }, dimensions: ["pack"] },
    skus: [{ id: skuId, productId, options: { pack: { kind: "quantity", value: option } }, netContent }],
  });
}
type TradeIdentifier = NonNullable<CatalogDraftPayload["skus"][number]["identifiers"]>[number];
const unitGtin: TradeIdentifier = { scheme: "gs1:gtin", issuer: "gs1", value: "0012345678905", packagingLevel: "unit" };
const caseGtin: TradeIdentifier = { scheme: "gs1:gtin", issuer: "gs1", value: "10012345678902", packagingLevel: "case" };
function identified(...identifiers: TradeIdentifier[]): CatalogDraftPayload {
  const value = payload(); value.skus[0].identifiers = identifiers;
  return value;
}
function issues(value: CatalogDraftPayload, types = registry) {
  const result = validateCatalogDraft(value, types);
  return result.valid ? [] : result.issues;
}
function readiness(value: CatalogDraftPayload) {
  const result = validateCatalogDraft(value, registry);
  if (!result.valid) throw new Error(`unexpected issues: ${JSON.stringify(result.issues)}`);
  return result.readiness;
}

describe("net content and trade identifiers", () => {
  it("compares a net-content option with the SKU's net content, without converting units", () => {
    const mismatch = [{ path: "skus.0.options.pack", code: "net_content_option_mismatch" }];
    expect(issues(packed(count("6"), count("12")), packRegistry)).toEqual(mismatch);
    expect(issues(packed(count("12"), count("1", 0, "item:dozen")), packRegistry)).toEqual(mismatch);
    expect(issues(packed(count("6"), count("600", 2)), packRegistry)).toEqual([]);
  });
  it("leaves a type without the role unaffected", () => {
    const value = payload();
    Object.assign(value.skus[0], { options: { finish: { kind: "choice", value: "matte" }, size }, netContent: count("2") });
    expect(issues(value)).toEqual([]);
  });
  it("accepts gs1:gtin as the only gs1 scheme", () => {
    expect(issues(identified({ ...unitGtin, scheme: "gs1:upc" }))).toEqual([{ path: "skus.0.identifiers.0", code: "trade_identifier_scheme_unsupported" }]);
    expect(issues(identified(unitGtin, { scheme: "example:catalog", issuer: "example", value: "A-1", packagingLevel: "unit" }))).toEqual([]);
  });
  it("treats every spelling and issuer text of one GTIN as one identity", () => {
    for (const spelling of ["012345678905", "00012345678905"]) {
      for (const issuer of ["gs1", "another issuer"]) {
        expect(issues(identified(unitGtin, { ...unitGtin, value: spelling, issuer }))).toEqual([{ path: "skus.0.identifiers.1", code: "duplicate_trade_identifier" }]);
      }
    }
  });
  it("needs a case identifier to state at least 2 units and a unit identifier none or 1", () => {
    const invalid = (index: number) => [{ path: `skus.0.identifiers.${index}.quantity`, code: "trade_identifier_quantity_invalid" }];
    expect(issues(identified(unitGtin, caseGtin))).toEqual(invalid(1));
    expect(issues(identified(unitGtin, { ...caseGtin, quantity: 1 }))).toEqual(invalid(1));
    expect(issues(identified(unitGtin, { ...caseGtin, quantity: 2 }))).toEqual([]);
    expect(issues(identified({ ...unitGtin, quantity: 2 }))).toEqual(invalid(0));
    expect(issues(identified({ ...unitGtin, quantity: 1 }))).toEqual([]);
    expect(issues(identified(unitGtin))).toEqual([]);
  });
  it("reports a SKU without a unit GTIN in commercial readiness only", () => {
    const missing = { path: "skus.0.identifiers", code: "unit_trade_identifier_missing" };
    const caseOnly = readiness(identified({ ...caseGtin, quantity: 6 }));
    expect(caseOnly.commercial.issues).toContainEqual(missing);
    expect(caseOnly.publication.issues).not.toContainEqual(missing);
    expect(readiness(identified(unitGtin, { ...caseGtin, quantity: 6 })).commercial.issues).not.toContainEqual(missing);
    expect(readiness(payload()).commercial.issues).toEqual(expect.arrayContaining([{ path: "skus.0.identifiers", code: "channel_identity_not_assessed" }, missing]));
  });
});
