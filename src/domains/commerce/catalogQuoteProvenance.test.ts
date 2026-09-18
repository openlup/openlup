import { describe, expect, it } from "vitest";
import { catalogQuoteProvenanceSchema } from "./catalogQuoteProvenance.js";

function provenance(mode: "one_time" | "subscription" = "subscription") {
  return {
    skuId: "11111111-1111-4111-8111-111111111111",
    documentRevisionId: "22222222-2222-4222-8222-222222222222",
    documentDigest: "a".repeat(64),
    basePriceEntryId: "33333333-3333-4333-8333-333333333333",
    policyRevisionId: mode === "subscription" ? "44444444-4444-4444-8444-444444444444" : null,
    policyDigest: mode === "subscription" ? "b".repeat(64) : null,
    mode,
    atTime: "2026-08-27T00:00:00.000Z",
    currency: "USD",
    baseUnitAmountMinor: 1490,
    resolvedLineAmountMinor: 1340,
  };
}

describe("catalog quote provenance", () => {
  it("round-trips losslessly through JSON and JSONB-shaped values", () => {
    const parsed = catalogQuoteProvenanceSchema.parse(provenance());
    const jsonRoundTrip = JSON.parse(JSON.stringify(parsed));
    const jsonbRoundTrip = JSON.parse(JSON.stringify(jsonRoundTrip));

    expect(catalogQuoteProvenanceSchema.parse(jsonbRoundTrip)).toEqual(parsed);
  });

  it("requires every immutable catalog, price and policy reference", () => {
    for (const key of ["skuId", "documentRevisionId", "documentDigest", "basePriceEntryId", "atTime", "currency", "baseUnitAmountMinor", "resolvedLineAmountMinor"]) {
      const candidate = provenance() as Record<string, unknown>;
      delete candidate[key];
      expect(catalogQuoteProvenanceSchema.safeParse(candidate).success, key).toBe(false);
    }
  });

  it("permits a null policy only for a one-time quote", () => {
    expect(catalogQuoteProvenanceSchema.safeParse(provenance("one_time")).success).toBe(true);
    expect(catalogQuoteProvenanceSchema.safeParse({ ...provenance(), policyDigest: null }).success).toBe(false);
    expect(catalogQuoteProvenanceSchema.safeParse({ ...provenance("one_time"), policyRevisionId: "44444444-4444-4444-8444-444444444444" }).success).toBe(false);
  });

  it.each([
    ["non-UUID SKU", { skuId: "sku-1" }],
    ["malformed digest", { documentDigest: "sha256:bad" }],
    ["lowercase currency", { currency: "usd" }],
    ["fractional money", { baseUnitAmountMinor: 14.9 }],
  ])("refuses %s", (_label, patch) => {
    expect(catalogQuoteProvenanceSchema.safeParse({ ...provenance(), ...patch }).success).toBe(false);
  });
});
