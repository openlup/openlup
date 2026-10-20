import type { PricingResolverPort } from "@openlup/core/pricing";
import { buildLineBreakdown } from "@openlup/core/pricing";
import type { CreateQuoteResponse, PricingPolicySnapshot, CreateQuoteRequest, CommerceQuoteContext, CommerceQuoteLine, CommerceQuotePricingComponent, CommerceTaxProfile, CommerceQuoteDiscount, CommerceCodeRejection, CommerceCodeRejectionDetail, CartLineInput } from "./contracts/index.js";
import { COMMERCE_CONTRACT_VERSION, PROMOTION_ENGINE_V2 } from "./contracts/index.js";
import { CommerceQuoteError, type CreateQuoteOptions } from "./quotePorts.js";
import { splitIncludedVat } from "./quoteSchemas.js";
import type { CommercePriceAuthorityPort } from "./ports.js";
import { assertSubscriptionCheapest, buildSkuIndex, calculateIncludedVat, eligibleQtyForMode, mapPricingComponent, moneyIn, resolveOneTimeComparison, resolveStrictQuotePrice, sum, toGrossMinor } from "./dbBackedCommerceQuoteHelpers.js";
import { assertSupportedCommerceTaxProfile } from "./taxProfileGuard.js";
import type { CommerceQuoteCatalogItem } from "./commerceQuoteCatalogReadPort.js";
import { catalogFactsForQuoteLine, projectPublicQuoteSnapshot } from "./catalogFactsProvenance.js";

export interface QuotePromotionResult {
  discounts: CommerceQuoteDiscount[];
  codeRejections: CommerceCodeRejection[];
  codeRejectionDetails: CommerceCodeRejectionDetail[];
}

export interface DbBackedCommerceQuotePortDeps<Request extends CreateQuoteRequest, Item extends CommerceQuoteCatalogItem, LineContext extends object, Context extends CommerceQuoteContext> {
  quoteCatalogReadPort: { listQuoteCatalogItems(): Promise<Item[]> };
  isStrictD1Quote: boolean;
  commercePriceAuthorityPort?: CommercePriceAuthorityPort;
  pricingResolverPort?: PricingResolverPort;
  taxProfile: CommerceTaxProfile;
  supportedTaxProfiles: readonly CommerceTaxProfile[];
  regionCode: string;
  currency: string;
  now?: () => string;
  shippingFlatMinor?: () => Promise<number>;
  hasPromotionCodePort: boolean;
  lineContext(line: CartLineInput, item: Item): LineContext;
  quoteContext(request: Request, lines: Array<LineContext & { line: CommerceQuoteLine }>): () => Context;
  resolveAutomaticQuotePromotions(input: {
    request: Request; options?: CreateQuoteOptions; regionCode: string;
    referenceProductMinor: number; subtotalGrossMinor: number; shippingGrossMinor: number; atTime: string;
  }): Promise<Pick<QuotePromotionResult, "discounts" | "codeRejections">>;
  applyPromotionCodesV2(input: {
    preserveLegacyDiscountsWhenNoCandidates: boolean; clientId: string | null;
    mode: Request["mode"]; promoCodes: string[]; referenceProductMinor: number;
    subtotalGrossMinor: number; shippingGrossMinor: number;
    discounts: CommerceQuoteDiscount[]; codeRejections: CommerceCodeRejection[]; atTime: string;
  }): Promise<QuotePromotionResult>;
}

const STRICT_D1_COMMERCE_CHANNEL = "D2C";
export function createDbBackedCommerceQuotePort<
  Request extends CreateQuoteRequest, Item extends CommerceQuoteCatalogItem,
  LineContext extends object, Context extends CommerceQuoteContext,
>(deps: DbBackedCommerceQuotePortDeps<Request, Item, LineContext, Context>) {
  const {
    taxProfile, supportedTaxProfiles, regionCode, currency,
    now = () => new Date().toISOString(),
    quoteCatalogReadPort, isStrictD1Quote, pricingResolverPort,
    commercePriceAuthorityPort, shippingFlatMinor, resolveAutomaticQuotePromotions,
    applyPromotionCodesV2, hasPromotionCodePort, lineContext, quoteContext,
  } = deps;
  assertSupportedCommerceTaxProfile(taxProfile, supportedTaxProfiles);
  const money = moneyIn(currency);
  async function createServerAuthoritativeQuote(
      request: Request,
      options?: CreateQuoteOptions,
    ): Promise<Omit<CreateQuoteResponse, "quote"> & { quote: Omit<CreateQuoteResponse["quote"], "context"> & { context: Context & { pricingPolicy?: PricingPolicySnapshot } } }> {
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
              commercePriceAuthorityPort: commercePriceAuthorityPort!,
              variantId: entry.item.variantId,
              mode: modeAtLine,
              regionCode,
              currency,
              channel: STRICT_D1_COMMERCE_CHANNEL,
              atTime,
            })
          : undefined;
        const resolved = strictResolution?.resolved ?? await pricingResolverPort!.resolvePrice({
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
          pricingResolverPort: pricingResolverPort!,
          variantId: entry.item.variantId,
          lineQty: requestLine.quantity,
          eligibleCartQty,
          regionCode,
          currency,
          atTime,
        });
        const promotionReference = hasPromotionCodePort && request.promoCodes.length > 0
          ? strictResolution?.base ?? await resolveOneTimeComparison({
              pricingResolverPort: pricingResolverPort!,
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
          ...lineContext(requestLine, entry.item),
          referenceGrossMinor: toGrossMinor(promotionReference ?? oneTime ?? resolved, taxProfile.vatRateBps)
            * requestLine.quantity,
        };
      }));
      const lines: CommerceQuoteLine[] = pricedLines.map((entry) => entry.line);
      const quoteComponents: CommerceQuotePricingComponent[] = pricedLines.flatMap((entry) => entry.pricingComponents);
      const context = quoteContext(request, pricedLines);
      const subtotalGrossMinor = sum(lines.map((line) => line.lineSubtotalGross.amountMinor));
      const referenceProductMinor = sum(pricedLines.map((entry) => entry.referenceGrossMinor));
      const netTotalMinor = sum(lines.map((line) => line.tax.netAmount.amountMinor));
      const taxTotalMinor = sum(lines.map((line) => line.tax.vatAmount.amountMinor));
      // Shipping is a flat per-order gross from settings; absent settings port ⇒ no
      // shipping (byte-identical to pre-shipping quotes). Resolved before promo eval so
      // the free-shipping lane has a real amount to zero.
      const shippingGrossMinor = shippingFlatMinor
        ? await shippingFlatMinor()
        : 0;
      const automaticPromotionResult = await resolveAutomaticQuotePromotions({
        request,
        options,
        regionCode,
        referenceProductMinor,
        subtotalGrossMinor,
        shippingGrossMinor,
        atTime,
      });
      const promotionResult = await applyPromotionCodesV2({
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
      const hasShipping = shippingFlatMinor != null;
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
            ...context(),
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
    createQuote: async (request: Request, options?: CreateQuoteOptions) => projectPublicQuoteSnapshot(await createServerAuthoritativeQuote(request, options)),
    createServerAuthoritativeQuote,
  };
}
