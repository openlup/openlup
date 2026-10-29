import type { SettlementProfileFallbacks } from "../../src/market-packs/index.js";
export const fallbacks: SettlementProfileFallbacks = {
  defaultCurrency: "USD", regionCode: "US",
  fiscalProfile: { included: true, country: "US", category: "standard", vatRateBps: 700, legalBasis: "Example rule" },
};
