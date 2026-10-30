import { describe, expect, it } from "vitest";
import { describeMarket, readSettlementProfile } from "../../src/market-packs/index.js";
import { fallbacks } from "./fixtures.js";

describe("explicit market description", () => {
  it("does not derive language, currency, pricing region or fiscal jurisdiction from one another", () => {
    const profile = readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "EUR", COMMERCE_SETTLEMENT_REGION: "CZ", COMMERCE_FISCAL_COUNTRY: "DE" }, fallbacks);
    expect(describeMarket("en", profile)).toEqual({ language: "en", currency: "EUR", pricingRegion: "CZ", fiscalJurisdiction: "DE" });
    expect(describeMarket("synthetic", profile)).toEqual({ ...describeMarket("en", profile), language: "synthetic" });
  });
});
