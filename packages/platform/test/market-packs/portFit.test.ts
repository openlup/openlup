import { fallbacks } from "./fixtures.js";
import { describe, expect, it } from "vitest";
import { describesSameSettlement, formatCurrencyMinor, readSettlementProfile } from "../../src/market-packs/index.js";

describe("market pack record fit", () => {
  it("keeps EN display, EUR settlement, region and fiscal jurisdiction independent", () => {
    const profile = readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "EUR", COMMERCE_SETTLEMENT_REGION: "CZ", COMMERCE_FISCAL_COUNTRY: "DE", COMMERCE_FISCAL_CATEGORY: "standard", COMMERCE_FISCAL_VAT_RATE_BPS: "1900", COMMERCE_FISCAL_LEGAL_BASIS: "Example rule" }, fallbacks);
    expect(profile).toEqual({ defaultCurrency: "EUR", acceptedCurrencies: ["EUR"], exponent: 2, regionCode: "CZ", minimumProductPayableMinor: 100, fiscalProfile: { included: true, country: "DE", category: "standard", vatRateBps: 1900, legalBasis: "Example rule" } });
    expect(formatCurrencyMinor(1490, { currency: profile.defaultCurrency, locale: "en-US" })).toBe("€14.90");
    expect(formatCurrencyMinor(1000, { currency: "JPY", locale: "en-US" })).toBe("¥1,000");
  });
  it("retains profile equality for harmless repeat and rejects each conflicting field", () => {
    const p = readSettlementProfile({}, fallbacks); expect(describesSameSettlement(p, readSettlementProfile({}, fallbacks))).toBe(true);
    for (const delta of [{ defaultCurrency: "EUR" }, { acceptedCurrencies: ["EUR"] }, { exponent: 0 }, { regionCode: "DE" }, { minimumProductPayableMinor: 1 }, { fiscalProfile: { ...p.fiscalProfile, country: "DE" } }]) {
      expect(describesSameSettlement(p, { ...p, ...delta })).toBe(false);
    }
  });
  it("keeps configuration refusal order ahead of fiscal parsing", () => {
    expect(() => readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "bad", COMMERCE_SETTLEMENT_REGION: "bad", COMMERCE_FISCAL_COUNTRY: "bad" }, fallbacks)).toThrow("COMMERCE_SETTLEMENT_CURRENCY");
    expect(() => readSettlementProfile({ COMMERCE_SETTLEMENT_REGION: "bad", COMMERCE_FISCAL_COUNTRY: "bad" }, fallbacks)).toThrow("COMMERCE_SETTLEMENT_REGION");
  });
});
