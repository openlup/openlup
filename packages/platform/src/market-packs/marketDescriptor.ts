import type { SettlementProfile } from "./settlementProfile.js";

/** Independent display, settlement, price-list and fiscal facts supplied by a host. */
export interface MarketDescriptor {
  readonly language: string;
  readonly currency: string;
  readonly pricingRegion: string;
  readonly fiscalJurisdiction: string;
}

/** Describe explicit inputs without selecting a market or changing their values. */
export function describeMarket(language: string, profile: SettlementProfile): MarketDescriptor {
  return {
    language,
    currency: profile.defaultCurrency,
    pricingRegion: profile.regionCode,
    fiscalJurisdiction: profile.fiscalProfile.country,
  };
}
