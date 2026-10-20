import { createDbBackedCommerceQuotePort as createQuotePort } from "@openlup/platform/pricing";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceTaxProfile } from "../../../src/domains/commerce/types.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import { readSettlementProfile, type SettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import type { CommercePriceAuthorityPort, PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import type { CommerceSettingsPort } from "./commerceSettingsPort.js";
import type { PromotionCodeQuotePort } from "./promotionCodeQuotePort.js";
import { applyPromotionCodesV2 } from "./quotePromotionCodeAdjustments.js";
import { resolveAutomaticQuotePromotions } from "./quoteAutomaticPromotions.js";
import { catalogEnergyPerUnit, roundCoverage } from "./dbBackedCommerceQuoteHelpers.js";
import { createLegacyCommerceQuoteCatalogReadPort, type CommerceQuoteCatalogReadPort } from "./commerceQuoteCatalogReadPort.js";
export { assertSupportedCommerceTaxProfile } from "./commerceTaxProfileGuard.js";
interface DbBackedCommerceQuotePortBaseDeps {
  /**
   * Optional. When provided, the quote evaluates active promotions and emits
   * `discounts`. Omitted (e.g. in the standalone order-draft snapshot verifier),
   * the quote stays discount-free and byte-identical to the pre-promo behavior —
   * so a client-submitted discounted snapshot fails re-verification.
   */
  promoDataPort?: CommercePromoDataPort;
  /** Optional dark v2 code resolver. Omitted keeps legacy quote behavior exact. */
  promotionCodeQuotePort?: PromotionCodeQuotePort;
  /**
   * Optional. When provided, the quote prices shipping as a flat per-order gross from
   * `commerce_settings` (a free-shipping promo zeroes it in the shipping lane). Omitted,
   * the quote carries no shipping fields — byte-identical to the pre-shipping behavior, so
   * existing snapshots and the discount-free order-draft verifier still match.
   */
  commerceSettingsPort?: CommerceSettingsPort;
  taxProfile?: CommerceTaxProfile;
  supportedTaxProfiles?: readonly CommerceTaxProfile[];
  /** What this deployment settles in; the two defaults below are read from it. */
  settlementProfile?: SettlementProfile;
  regionCode?: string;
  currency?: string;
  now?: () => string;
}

/** Exactly one catalog source is required: legacy for untouched roots or D1 facts for cut-over roots. */
export type DbBackedCommerceQuotePortDeps = DbBackedCommerceQuotePortBaseDeps & (
  | { catalogReadPort: CatalogReadPort; quoteCatalogReadPort?: never; commercePriceAuthorityPort?: never; pricingResolverPort: PricingResolverPort }
  | { catalogReadPort?: never; quoteCatalogReadPort: CommerceQuoteCatalogReadPort; commercePriceAuthorityPort: CommercePriceAuthorityPort; pricingResolverPort?: never }
);

export function createDbBackedCommerceQuotePort(deps: DbBackedCommerceQuotePortDeps): CommerceQuotePort {
  const {
    promoDataPort,
    promotionCodeQuotePort,
    commerceSettingsPort,
    settlementProfile = readSettlementProfile(process.env),
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
    quoteCatalogReadPort, isStrictD1Quote,
    commercePriceAuthorityPort: deps.commercePriceAuthorityPort,
    pricingResolverPort: deps.pricingResolverPort,
    taxProfile, supportedTaxProfiles, regionCode, currency, now,
    shippingFlatMinor: commerceSettingsPort ? () => commerceSettingsPort.getShippingFlatMinor() : undefined,
    hasPromotionCodePort: !!promotionCodeQuotePort,
    resolveAutomaticQuotePromotions: (input) => resolveAutomaticQuotePromotions({ ...input, promoDataPort }),
    applyPromotionCodesV2: (input) => applyPromotionCodesV2({ ...input, port: promotionCodeQuotePort }),
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
