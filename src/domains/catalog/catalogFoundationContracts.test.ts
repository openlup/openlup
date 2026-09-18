import { describe, expect, it } from "vitest";
import {
  CatalogSkuAuthorityError,
  assertPrimaryUnitGtinAuthority,
  catalogSkuEnvelopeSelectorSchema,
  isValidGtin,
  neutralSkuEnvelopeV1Schema,
  requireCurrentCatalogDocumentAuthority,
} from "./catalogFoundationContracts.js";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const SKU_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";

function envelope() {
  return {
    contractVersion: "catalog.foundation.v1" as const,
    product: { id: PRODUCT_ID, slug: "formula-a", primarySkuId: SKU_ID },
    sku: {
      id: SKU_ID,
      productId: PRODUCT_ID,
      code: "FORMULA-A-400",
      netContent: { unscaled: 400, scale: 0, unit: "GRAM" },
      sellability: { status: "active" as const, oneTime: true, subscription: true },
      isAddon: false,
      assetRef: "asset:formula-a:400",
    },
    documentRevision: {
      id: DOCUMENT_ID,
      productId: PRODUCT_ID,
      revisionNo: 1,
      schemaId: "application:document/v1",
      documentRef: "document:formula-a/v1",
      sourceRef: "proposal:source/v1",
      digest: "a".repeat(64),
    },
    identifiers: [{
      issuer: "gs1",
      normalizedValue: "5908121193005",
      kind: "gtin" as const,
      packKind: "unit" as const,
      packQuantity: 1,
      isPrimary: true,
    }],
  };
}

describe("NeutralSkuEnvelopeV1", () => {
  it("carries one product-scoped revision across structural SKUs without a payload", () => {
    const first = neutralSkuEnvelopeV1Schema.parse(envelope());
    const second = neutralSkuEnvelopeV1Schema.parse({
      ...envelope(),
      sku: { ...envelope().sku, id: "44444444-4444-4444-8444-444444444444", code: "FORMULA-A-800", netContent: { unscaled: 800, scale: 0, unit: "GRAM" } },
    });

    expect(first.documentRevision.id).toBe(second.documentRevision.id);
    expect(first.documentRevision.digest).toBe(second.documentRevision.digest);
  });

  it.each([
    ["cross-product sku", { sku: { ...envelope().sku, productId: "55555555-5555-4555-8555-555555555555" } }],
    ["cross-product revision", { documentRevision: { ...envelope().documentRevision, productId: "55555555-5555-4555-8555-555555555555" } }],
    ["SKU document override", { sku: { ...envelope().sku, documentRevisionId: DOCUMENT_ID } }],
    ["raw document payload", { documentPayload: { arbitrary: "payload" } }],
    ["invalid primary GTIN checksum", { identifiers: [{ ...envelope().identifiers[0], normalizedValue: "5908121193000" }] }],
  ])("refuses %s", (_label, patch) => {
    const value = envelope();
    const candidate = { ...value, ...patch };
    expect(neutralSkuEnvelopeV1Schema.safeParse(candidate).success).toBe(false);
  });

  it("refuses identifier shapes that would create ambiguous authority", () => {
    const primaryTwice = envelope();
    primaryTwice.identifiers.push({ ...primaryTwice.identifiers[0], issuer: "other-gs1" });
    expect(neutralSkuEnvelopeV1Schema.safeParse(primaryTwice).success).toBe(false);

    const collectiveUnit = envelope();
    collectiveUnit.identifiers[0].packQuantity = 2;
    expect(neutralSkuEnvelopeV1Schema.safeParse(collectiveUnit).success).toBe(false);
  });

  it("allows a structurally valid draft envelope before a primary GTIN is assigned", () => {
    expect(neutralSkuEnvelopeV1Schema.safeParse({
      ...envelope(),
      sku: { ...envelope().sku, sellability: { ...envelope().sku.sellability, status: "draft" } },
      identifiers: [],
    }).success).toBe(true);
  });

  it.each([0, -1])("refuses non-positive SKU net content: %d", (unscaled) => {
    expect(neutralSkuEnvelopeV1Schema.safeParse({
      ...envelope(),
      sku: { ...envelope().sku, netContent: { ...envelope().sku.netContent, unscaled } },
    }).success).toBe(false);
  });

  it.each([
    "12345670",
    "012345678905",
    "5901234123457",
    "10012345678902",
  ])("accepts valid GS1 GTIN checksums: %s", (gtin) => {
    expect(isValidGtin(gtin)).toBe(true);
  });

  it.each(["12345671", "012345678904", "5901234123450", "1234567A"])("rejects invalid GTIN checksums or lengths: %s", (gtin) => {
    expect(isValidGtin(gtin)).toBe(false);
  });

  it("uses one neutral refusal vocabulary for SKU, document, and primary GTIN authority", () => {
    expect(() => assertPrimaryUnitGtinAuthority([])).toThrow(CatalogSkuAuthorityError);
    expect(() => assertPrimaryUnitGtinAuthority([
      envelope().identifiers[0],
      { ...envelope().identifiers[0], issuer: "another-gs1" },
    ])).toThrow("catalog_sku_identifier_authority_ambiguous");
    expect(() => assertPrimaryUnitGtinAuthority([
      { ...envelope().identifiers[0], normalizedValue: "5901234123450" },
    ])).toThrow("catalog_sku_identifier_authority_invalid");
    expect(() => requireCurrentCatalogDocumentAuthority(PRODUCT_ID, null, null)).toThrow("catalog_sku_authority_current_document_absent");
    expect(() => requireCurrentCatalogDocumentAuthority(PRODUCT_ID, DOCUMENT_ID, null)).toThrow("catalog_sku_authority_current_document_invalid");
  });

  it("accepts only the exact SKU-code and primary-product-slug selector union", () => {
    expect(catalogSkuEnvelopeSelectorSchema.parse({ kind: "sku_code", skuCode: "FORMULA-A-400" }))
      .toEqual({ kind: "sku_code", skuCode: "FORMULA-A-400" });
    expect(catalogSkuEnvelopeSelectorSchema.parse({ kind: "primary_product_slug", productSlug: "formula-a" }))
      .toEqual({ kind: "primary_product_slug", productSlug: "formula-a" });
    expect(catalogSkuEnvelopeSelectorSchema.safeParse({ kind: "sku_id", skuId: SKU_ID }).success).toBe(false);
    expect(catalogSkuEnvelopeSelectorSchema.safeParse({ kind: "sku_code", skuCode: "FORMULA A" }).success).toBe(false);
    expect(catalogSkuEnvelopeSelectorSchema.safeParse({ kind: "primary_product_slug", productSlug: "formula-a", skuCode: "FORMULA-A-400" }).success).toBe(false);
  });
});
