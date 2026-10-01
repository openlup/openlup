import { describe, expect, it } from "vitest";
import {
  COMMERCE_OFFER_EVIDENCE_MAX_JSON_LENGTH,
  commerceMinimumUnits,
  commerceMinimumUnitsSchema,
  commerceOfferEvidenceSchema,
  commerceOfferVersionSchema,
} from "./offerVersionContracts.js";
import { COMMERCE_MIN_ORDER_UNITS } from "./recommendationPolicyDeps.js";

describe("commerceOfferVersionSchema", () => {
  it.each(["v2", "a", "a-b_c.d", "offer.v2", "a".repeat(40)])("accepts the token %s", (token) => {
    expect(commerceOfferVersionSchema.safeParse(token).success).toBe(true);
  });

  it.each([
    ["uppercase", "Offer.v2"],
    ["a leading digit", "2offer"],
    ["a doubled separator", "a..b"],
    ["a trailing separator", "a."],
    ["a leading separator", "-a"],
    ["an empty token", ""],
    ["41 characters", "a".repeat(41)],
    ["a number", 2],
    ["null", null],
  ])("refuses %s", (_case, token) => {
    expect(commerceOfferVersionSchema.safeParse(token).success).toBe(false);
  });
});

describe("commerceMinimumUnits", () => {
  it("returns the minimum a snapshot or intent carries", () => {
    expect(commerceMinimumUnits({ minimumUnits: 12 })).toBe(12);
    expect(commerceMinimumUnits({ minimumUnits: 24 })).toBe(24);
  });

  it("falls back to the core default when the minimum is absent or null", () => {
    expect(commerceMinimumUnits({})).toBe(COMMERCE_MIN_ORDER_UNITS);
    expect(commerceMinimumUnits({ minimumUnits: undefined })).toBe(COMMERCE_MIN_ORDER_UNITS);
    expect(commerceMinimumUnits({ minimumUnits: null })).toBe(COMMERCE_MIN_ORDER_UNITS);
  });
});

describe("commerceMinimumUnitsSchema", () => {
  it("admits whole numbers from 1 to 99 only", () => {
    for (const units of [1, 12, 99]) {
      expect(commerceMinimumUnitsSchema.safeParse(units).success, String(units)).toBe(true);
    }
    for (const units of [0, 100, -1, 12.5, "12"]) {
      expect(commerceMinimumUnitsSchema.safeParse(units).success, String(units)).toBe(false);
    }
  });
});

describe("commerceOfferEvidenceSchema", () => {
  it("accepts identifier keys with any JSON value and returns them unchanged", () => {
    const evidence = { tier: "b", units: 12, detail: { reasons: ["first", "second"] } };

    expect(commerceOfferEvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it.each(["1tier", "tier-name", "tier name", "t".repeat(41), ""])("refuses the key %j", (key) => {
    expect(commerceOfferEvidenceSchema.safeParse({ [key]: 1 }).success).toBe(false);
  });

  it("refuses a value that is not a record", () => {
    expect(commerceOfferEvidenceSchema.safeParse(["tier"]).success).toBe(false);
    expect(commerceOfferEvidenceSchema.safeParse(null).success).toBe(false);
  });

  it("accepts exactly 4096 characters of JSON and refuses one more", () => {
    const envelope = JSON.stringify({ note: "" }).length;
    const atLimit = { note: "x".repeat(COMMERCE_OFFER_EVIDENCE_MAX_JSON_LENGTH - envelope) };
    const overLimit = { note: "x".repeat(COMMERCE_OFFER_EVIDENCE_MAX_JSON_LENGTH - envelope + 1) };

    expect(JSON.stringify(atLimit)).toHaveLength(4_096);
    expect(commerceOfferEvidenceSchema.safeParse(atLimit).success).toBe(true);
    const refused = commerceOfferEvidenceSchema.safeParse(overLimit);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe("offer evidence exceeds 4096 characters");
  });
});
