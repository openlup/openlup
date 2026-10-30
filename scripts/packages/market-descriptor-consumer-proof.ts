/** Additive installed descriptor proof; predecessor invoice witness remains unchanged. */
export const MARKET_DESCRIPTOR_CONSUMER_PROOF = `
import assert from "node:assert/strict";
import { describeMarket, readSettlementProfile } from "@openlup/platform/market-packs";
const fallback = { defaultCurrency: "XXX", regionCode: "ZZ", fiscalProfile: { included: true, country: "YY", category: "synthetic", vatRateBps: 0, legalBasis: "Synthetic fact" } };
const configuration = { COMMERCE_SETTLEMENT_CURRENCY: "EUR", COMMERCE_SETTLEMENT_REGION: "CZ", COMMERCE_FISCAL_COUNTRY: "DE" };
const profile = readSettlementProfile(configuration, fallback);
const descriptor = describeMarket("en", profile);
assert.deepEqual(descriptor, { language: "en", currency: "EUR", pricingRegion: "CZ", fiscalJurisdiction: "DE" });
assert.deepEqual(describeMarket("synthetic", profile), { ...descriptor, language: "synthetic" });
assert.deepEqual(describeMarket("en", readSettlementProfile({ ...configuration, COMMERCE_SETTLEMENT_REGION: "XY" }, fallback)), { ...descriptor, pricingRegion: "XY" });
console.log("market descriptor installed consumer PASS");
`;
