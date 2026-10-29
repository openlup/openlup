import { describeMarket, readSettlementProfile } from "@openlup/platform/market-packs";
import { PLATFORM_DEFAULT_CURRENCY, PLATFORM_DEFAULT_REGION } from "../../../src/lib/currency/settlementProfile.js";
import { PLATFORM_DEFAULT_FISCAL_PROFILE } from "../../../src/lib/currency/fiscalProfile.js";
import { DEFAULT_MONEY_LANG } from "../../../src/lib/currency/formatMinor.js";

export const referenceSettlementFallbacks = {
  defaultCurrency: PLATFORM_DEFAULT_CURRENCY,
  regionCode: PLATFORM_DEFAULT_REGION,
  fiscalProfile: PLATFORM_DEFAULT_FISCAL_PROFILE,
};

/** Compatibility data only. Ambient settlement remains owned by the application. */
export const referenceMarketDescriptor = describeMarket(
  DEFAULT_MONEY_LANG,
  readSettlementProfile({}, referenceSettlementFallbacks),
);
