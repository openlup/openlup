import { describe, expect, it } from "vitest";
import { buildResolvedSkuProjection, resolvedSkuProjectionSchema } from "./resolvedSkuProjection.js";

function input() {
  return {
    contractVersion: "catalog.resolved-sku.v1" as const,
    envelope: {
      contractVersion: "catalog.foundation.v1" as const,
      product: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "formula-a",
        primarySkuId: "22222222-2222-4222-8222-222222222222",
      },
      sku: {
        id: "22222222-2222-4222-8222-222222222222",
        productId: "11111111-1111-4111-8111-111111111111",
        code: "FORMULA-A-400",
        netContent: { unscaled: 400, scale: 0, unit: "GRAM" },
        sellability: { status: "active" as const, oneTime: true, subscription: true },
        isAddon: false,
        assetRef: "asset:formula-a:400",
      },
      documentRevision: {
        id: "33333333-3333-4333-8333-333333333333",
        productId: "11111111-1111-4111-8111-111111111111",
        revisionNo: 1,
        schemaId: "application:document/v1",
        documentRef: "document:formula-a/v1",
        sourceRef: "proposal:source/v1",
        digest: "a".repeat(64),
      },
      identifiers: [{ issuer: "gs1", normalizedValue: "5908121193005", kind: "gtin" as const, packKind: "unit" as const, packQuantity: 1, isPrimary: true }],
    },
    priceContext: { priceListId: "44444444-4444-4444-8444-444444444444", regionCode: "US", currency: "USD", channel: "D2C", atTime: "2026-08-27T00:00:00.000Z" },
    pricing: {
      base: { priceEntryId: "55555555-5555-4555-8555-555555555555", amountMinor: 1490 },
      subscription: { policyRevisionId: "66666666-6666-4666-8666-666666666666", policyDigest: "b".repeat(64), amountMinor: 1340 },
    },
  };
}

describe("ResolvedSkuProjection", () => {
  it("composes the row-safe envelope with contextual prices", () => {
    const projection = buildResolvedSkuProjection(input());
    expect(projection.envelope.documentRevision.digest).toBe("a".repeat(64));
    expect(projection.pricing.subscription).toMatchObject({ amountMinor: 1340 });
  });

  it("refuses document payload and SKU document overrides", () => {
    expect(resolvedSkuProjectionSchema.safeParse({ ...input(), envelope: { ...input().envelope, documentPayload: { nope: true } } }).success).toBe(false);
    expect(resolvedSkuProjectionSchema.safeParse({ ...input(), envelope: { ...input().envelope, sku: { ...input().envelope.sku, documentRevisionId: "33333333-3333-4333-8333-333333333333" } } }).success).toBe(false);
  });

  it("requires subscription pricing only when the SKU is subscription-sellable", () => {
    expect(resolvedSkuProjectionSchema.safeParse({ ...input(), pricing: { ...input().pricing, subscription: null } }).success).toBe(false);

    const oneTimeOnly = {
      ...input(),
      envelope: { ...input().envelope, sku: { ...input().envelope.sku, sellability: { ...input().envelope.sku.sellability, subscription: false } } },
      pricing: { ...input().pricing, subscription: null },
    };
    expect(resolvedSkuProjectionSchema.safeParse(oneTimeOnly).success).toBe(true);
    expect(resolvedSkuProjectionSchema.safeParse({ ...oneTimeOnly, pricing: input().pricing }).success).toBe(false);
  });

  it("requires one primary unit GTIN even though a draft envelope may still be incomplete", () => {
    const incompleteDraft = {
      ...input(),
      envelope: {
        ...input().envelope,
        sku: { ...input().envelope.sku, sellability: { ...input().envelope.sku.sellability, status: "draft" as const } },
        identifiers: [],
      },
    };

    expect(resolvedSkuProjectionSchema.safeParse(incompleteDraft).success).toBe(false);
    expect(() => buildResolvedSkuProjection(incompleteDraft)).toThrow("catalog_sku_identifier_authority_absent");
  });
});
