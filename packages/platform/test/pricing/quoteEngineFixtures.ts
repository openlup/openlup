import { createDbBackedCommerceQuotePort as createQuotePort } from "../../src/pricing/index.js";
import type { PricingResolverPort } from "@openlup/core/pricing";
import type { CommercePriceAuthorityPort, CommerceTaxProfile } from "../../src/pricing/index.js";
import type { CreateQuoteRequest, CommerceQuotePort } from "./quoteSchemaFixtures.js";
import { readSettlementProfile } from "./neutralFixtures.js";
import { createLegacyCommerceQuoteCatalogReadPort, type CatalogReadPort, type CommerceQuoteCatalogReadPort } from "./catalogFixtures.js";
type DbBackedCommerceQuotePortDeps = {
  catalogReadPort?: CatalogReadPort; quoteCatalogReadPort?: CommerceQuoteCatalogReadPort;
  pricingResolverPort?: PricingResolverPort; commercePriceAuthorityPort?: CommercePriceAuthorityPort;
  settlementProfile?: ReturnType<typeof readSettlementProfile>; taxProfile?: CommerceTaxProfile;
  supportedTaxProfiles?: readonly CommerceTaxProfile[]; regionCode?: string; currency?: string; now?: () => string;
};
export function createDbBackedCommerceQuotePort(deps: DbBackedCommerceQuotePortDeps): CommerceQuotePort {
  const {
    settlementProfile = readSettlementProfile(),
    // The seam was already here; only the value behind it stopped being a constant.
    // The supported set stays one member: it is plural so a per-jurisdiction
    // catalogue can arrive without reshaping anything, not because one exists.
    taxProfile = settlementProfile.fiscalProfile,
    supportedTaxProfiles = [settlementProfile.fiscalProfile],
    regionCode = settlementProfile.regionCode,
    currency = settlementProfile.defaultCurrency,
    now = () => new Date().toISOString(),
  } = deps;
  const quoteCatalogReadPort = deps.catalogReadPort
    ? createLegacyCommerceQuoteCatalogReadPort(deps.catalogReadPort)
    : deps.quoteCatalogReadPort;
  const isStrictD1Quote = deps.catalogReadPort === undefined;
  return createQuotePort({
    quoteCatalogReadPort: quoteCatalogReadPort!, isStrictD1Quote,
    commercePriceAuthorityPort: deps.commercePriceAuthorityPort,
    pricingResolverPort: deps.pricingResolverPort,
    taxProfile, supportedTaxProfiles, regionCode, currency, now,
    hasPromotionCodePort: false,
    resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: async () => ({ discounts: [], codeRejections: [], codeRejectionDetails: [] }),
    lineContext: (requestLine, item) => ({
      isAddon: requestLine.isAddon ?? item.isAddon,
      kcalPerUnit: catalogEnergyPerUnit(item.energyPer100g, item.netWeightG),
    }),
    quoteContext: (request: CreateQuoteRequest, pricedLines) => {
      const dailyKcal = request.sizeConstraint?.dailyKcalOverride
        ?? request.petProfileContext?.dailyKcalOverride;
      const recipeLines = pricedLines.filter((entry) => !entry.isAddon);
      const feedingCoverageDays = dailyKcal && recipeLines.every((entry) => entry.kcalPerUnit != null)
        ? roundCoverage(recipeLines.reduce(
          (total, entry) => total + (entry.kcalPerUnit ?? 0) * entry.line.quantity,
          0,
        ) / dailyKcal)
        : null;
      return () => ({
            mode: request.mode,
            cadenceDays: request.cadenceDays ?? null,
            feedingCoverageDays,
            sizeConstraint: request.sizeConstraint,
            promoCodes: request.promoCodes,
            petId: request.petId ?? null,
            petProfileContext: request.petProfileContext,
      });
    },
  });
}
/**
 * Energy content of one unit of a SKU, from the product's per-100g composition
 * and the SKU's net weight. Null when either input is missing, because an
 * estimate resting on a guessed weight is worse than no estimate at all.
 */
export function catalogEnergyPerUnit(
  kcalPer100g: number | null | undefined,
  netWeightGrams: number | undefined,
): number | null {
  return Number.isFinite(kcalPer100g) && Number.isFinite(netWeightGrams)
    ? Math.round(((kcalPer100g as number) * (netWeightGrams as number)) / 100)
    : null;
}

/** Coverage days, rounded to one decimal. Informational only. */
export function roundCoverage(value: number): number {
  return Math.round(value * 10) / 10;
}
