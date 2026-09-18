import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CreateQuoteRequest, CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuoteLine, CommerceQuotePricingComponent, CommerceTaxProfile } from "../../../src/domains/commerce/types.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { PROMOTION_ENGINE_V2 } from "../../../src/domains/commerce/offerPolicyContracts.js";
import { buildLineBreakdown } from "../../../src/domains/commerce/pricingBreakdown.js";
import { CommerceQuoteError, type CommerceQuotePort, type CreateQuoteOptions } from "../../../src/domains/commerce/ports.js";
import { splitIncludedVat } from "../../../src/domains/commerce/quoteContracts.js";
import { readSettlementProfile, type SettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import type { CommercePriceAuthorityPort, PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import type { CommerceSettingsPort } from "./commerceSettingsPort.js";
import type { PromotionCodeQuotePort } from "./promotionCodeQuotePort.js";
import { applyPromotionCodesV2 } from "./quotePromotionCodeAdjustments.js";
import { resolveAutomaticQuotePromotions } from "./quoteAutomaticPromotions.js";
import {
  assertSubscriptionCheapest, buildSkuIndex, calculateIncludedVat, catalogEnergyPerUnit,
  eligibleQtyForMode, mapPricingComponent, moneyIn, resolveOneTimeComparison, resolveStrictQuotePrice,
  roundCoverage, sum, toGrossMinor,
} from "./dbBackedCommerceQuoteHelpers.js";
import { assertSupportedCommerceTaxProfile } from "./commerceTaxProfileGuard.js";
import { createLegacyCommerceQuoteCatalogReadPort, type CommerceQuoteCatalogReadPort } from "./commerceQuoteCatalogReadPort.js";
import { catalogFactsForQuoteLine, projectPublicQuoteSnapshot } from "./catalogFactsProvenance.js";
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

const STRICT_D1_COMMERCE_CHANNEL = "D2C";
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
  assertSupportedCommerceTaxProfile(taxProfile, supportedTaxProfiles);
  const money = moneyIn(currency);
  async function createServerAuthoritativeQuote(
      request: CreateQuoteRequest,
      options?: CreateQuoteOptions,
    ): Promise<CreateQuoteResponse> {
      const atTime = now();
      const skuIndex = await buildSkuIndex(quoteCatalogReadPort);
      const pricedLines = await Promise.all(request.lines.map(async (requestLine) => {
        const entry = skuIndex.get(requestLine.sku);
        if (!entry || (requestLine.variantId && requestLine.variantId !== entry.item.variantId)) {
          throw new CommerceQuoteError("UNKNOWN_SKU", "Unknown commerce SKU", {
            sku: requestLine.sku,
            variantId: requestLine.variantId ?? null,
          });
        }
        const modeAtLine = requestLine.modeAtLine ?? request.mode;
        if (!entry.item.sellability[modeAtLine === "one_time" ? "oneTime" : "subscription"]) {
          throw new CommerceQuoteError("UNKNOWN_SKU", "Commerce SKU is not sellable in this purchase mode", {
            sku: requestLine.sku,
            variantId: entry.item.variantId,
            mode: modeAtLine,
          });
        }
        const eligibleCartQty = eligibleQtyForMode(request, modeAtLine);
        const strictResolution = isStrictD1Quote
          ? await resolveStrictQuotePrice({
              commercePriceAuthorityPort: deps.commercePriceAuthorityPort!,
              variantId: entry.item.variantId,
              mode: modeAtLine,
              regionCode,
              currency,
              channel: STRICT_D1_COMMERCE_CHANNEL,
              atTime,
            })
          : undefined;
        const resolved = strictResolution?.resolved ?? await deps.pricingResolverPort!.resolvePrice({
          variantId: entry.item.variantId,
          mode: modeAtLine,
          lineQty: requestLine.quantity,
          eligibleCartQty,
          regionCode,
          currency,
          atTime,
        });
        if (!resolved) {
          throw new CommerceQuoteError("PRICE_NOT_CONFIGURED", "Commerce price is not configured", {
            sku: requestLine.sku,
            variantId: entry.item.variantId,
            mode: modeAtLine,
          });
        }
        const oneTime = strictResolution?.base ?? await resolveOneTimeComparison({
          pricingResolverPort: deps.pricingResolverPort!,
          variantId: entry.item.variantId,
          lineQty: requestLine.quantity,
          eligibleCartQty,
          regionCode,
          currency,
          atTime,
        });
        const promotionReference = promotionCodeQuotePort && request.promoCodes.length > 0
          ? strictResolution?.base ?? await resolveOneTimeComparison({
              pricingResolverPort: deps.pricingResolverPort!,
              variantId: entry.item.variantId,
              lineQty: requestLine.quantity,
              eligibleCartQty: 1,
              regionCode,
              currency,
              atTime,
            })
          : oneTime;
        assertSubscriptionCheapest({
          requestSku: requestLine.sku,
          modeAtLine,
          resolved,
          oneTime,
          vatRateBps: taxProfile.vatRateBps,
        });
        const unitPriceGrossMinor = toGrossMinor(resolved, taxProfile.vatRateBps);
        const baseUnitGrossMinor = oneTime ? toGrossMinor(oneTime, taxProfile.vatRateBps) : unitPriceGrossMinor;
        const grossMinor = unitPriceGrossMinor * requestLine.quantity;
        const tax = calculateIncludedVat(grossMinor, taxProfile.vatRateBps);
        const pricingComponents = buildLineBreakdown({
          variant_id: entry.item.variantId,
          line_qty: requestLine.quantity,
          base_unit_price_minor: baseUnitGrossMinor,
          resolved_unit_price_minor: unitPriceGrossMinor,
          matched_tier_min_qty: resolved.matchedMinQty,
          mode_at_line: modeAtLine,
          mode_resolved_via_fallback: resolved.mode === "any",
        }).map((component) => mapPricingComponent(component, "line"));
        const catalogFacts = isStrictD1Quote
          ? catalogFactsForQuoteLine(true, entry.item, resolved, oneTime!, modeAtLine, atTime, currency, unitPriceGrossMinor, grossMinor, toGrossMinor(oneTime!, taxProfile.vatRateBps), strictResolution?.policy)
          : undefined;
        return {
          line: {
            sku: entry.item.skuCode,
            productSlug: entry.item.productSlug,
            quantity: requestLine.quantity,
            unitPriceGross: money(unitPriceGrossMinor),
            lineSubtotalGross: money(grossMinor),
            tax: {
              ...taxProfile,
              netAmount: money(tax.netMinor),
              vatAmount: money(tax.vatMinor),
              grossAmount: money(grossMinor),
            },
            pricingComponents,
            ...(catalogFacts ? { catalogFacts } : {}),
          },
          pricingComponents,
          isAddon: requestLine.isAddon ?? entry.item.isAddon,
          kcalPerUnit: catalogEnergyPerUnit(
            entry.item.energyPer100g,
            entry.item.netWeightG,
          ),
          referenceGrossMinor: toGrossMinor(promotionReference ?? oneTime ?? resolved, taxProfile.vatRateBps)
            * requestLine.quantity,
        };
      }));
      const lines: CommerceQuoteLine[] = pricedLines.map((entry) => entry.line);
      const quoteComponents: CommerceQuotePricingComponent[] = pricedLines.flatMap((entry) => entry.pricingComponents);
      const dailyKcal = request.sizeConstraint?.dailyKcalOverride
        ?? request.petProfileContext?.dailyKcalOverride;
      const recipeLines = pricedLines.filter((entry) => !entry.isAddon);
      const feedingCoverageDays = dailyKcal && recipeLines.every((entry) => entry.kcalPerUnit != null)
        ? roundCoverage(recipeLines.reduce(
          (total, entry) => total + (entry.kcalPerUnit ?? 0) * entry.line.quantity,
          0,
        ) / dailyKcal)
        : null;
      const subtotalGrossMinor = sum(lines.map((line) => line.lineSubtotalGross.amountMinor));
      const referenceProductMinor = sum(pricedLines.map((entry) => entry.referenceGrossMinor));
      const netTotalMinor = sum(lines.map((line) => line.tax.netAmount.amountMinor));
      const taxTotalMinor = sum(lines.map((line) => line.tax.vatAmount.amountMinor));
      // Shipping is a flat per-order gross from settings; absent settings port ⇒ no
      // shipping (byte-identical to pre-shipping quotes). Resolved before promo eval so
      // the free-shipping lane has a real amount to zero.
      const shippingGrossMinor = commerceSettingsPort
        ? await commerceSettingsPort.getShippingFlatMinor()
        : 0;
      const automaticPromotionResult = await resolveAutomaticQuotePromotions({
        promoDataPort,
        request,
        options,
        regionCode,
        referenceProductMinor,
        subtotalGrossMinor,
        shippingGrossMinor,
        atTime,
      });
      const promotionResult = await applyPromotionCodesV2({
        port: promotionCodeQuotePort,
        preserveLegacyDiscountsWhenNoCandidates: options?.pricingPolicy?.promotionEngineVersion !== PROMOTION_ENGINE_V2,
        clientId: options?.clientId ?? null,
        mode: request.mode,
        promoCodes: request.promoCodes,
        referenceProductMinor: sum(pricedLines.map((entry) => entry.referenceGrossMinor)),
        subtotalGrossMinor,
        shippingGrossMinor,
        discounts: automaticPromotionResult.discounts,
        codeRejections: automaticPromotionResult.codeRejections,
        atTime,
      });
      const { discounts, codeRejections, codeRejectionDetails } = promotionResult;
      // Two lanes: order_total/line discounts reduce the subtotal; a shipping discount
      // (free-shipping promo) reduces the shipping gross. They are summed and validated
      // independently by the quote schema.
      const orderDiscountMinor = discounts
        .filter((d) => d.appliesTo !== "shipping")
        .reduce((total, d) => total + d.amountOffMinor, 0);
      const shippingDiscountMinor = discounts
        .filter((d) => d.appliesTo === "shipping")
        .reduce((total, d) => total + d.amountOffMinor, 0);

      const { netMinor: discountNetMinor, vatMinor: discountVatMinor } = splitIncludedVat(
        orderDiscountMinor,
        taxProfile.vatRateBps,
      );
      const ship = splitIncludedVat(shippingGrossMinor, taxProfile.vatRateBps);
      const shipDiscount = splitIncludedVat(shippingDiscountMinor, taxProfile.vatRateBps);
      const hasShipping = commerceSettingsPort != null;
      const shippingFields = hasShipping
        ? {
            shippingGross: money(shippingGrossMinor),
            shippingDiscountGross: money(shippingDiscountMinor),
          }
        : {};
      return {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        quote: {
          currency,
          taxIncluded: true,
          lines,
          discounts,
          ...(codeRejections.length ? { codeRejections } : {}),
          ...(codeRejectionDetails.length ? { codeRejectionDetails } : {}),
          pricingComponents: quoteComponents,
          context: {
            mode: request.mode,
            cadenceDays: request.cadenceDays ?? null,
            feedingCoverageDays,
            sizeConstraint: request.sizeConstraint,
            promoCodes: request.promoCodes,
            petId: request.petId ?? null,
            petProfileContext: request.petProfileContext,
            ...(options?.pricingPolicy ? { pricingPolicy: options.pricingPolicy } : {}),
          },
          subtotalGross: money(subtotalGrossMinor),
          discountTotalGross: money(orderDiscountMinor),
          ...shippingFields,
          totalGross: money(subtotalGrossMinor - orderDiscountMinor + shippingGrossMinor - shippingDiscountMinor),
          netTotal: money(netTotalMinor - discountNetMinor + ship.netMinor - shipDiscount.netMinor),
          taxTotal: money(taxTotalMinor - discountVatMinor + ship.vatMinor - shipDiscount.vatMinor),
        },
      };
    }

  return {
    createQuote: async (request, options) => projectPublicQuoteSnapshot(await createServerAuthoritativeQuote(request, options)),
    createServerAuthoritativeQuote,
  };
}
