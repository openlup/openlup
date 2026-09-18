import {
  COMMERCE_OFFER_PRICING_CONTRACT_VERSION,
  COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION,
  type CommerceOfferPricingResponse,
  type CommerceProductOfferPricing,
} from "../../../src/domains/commerce/offerPricingContracts.js";
import {
  OFFER_POLICY_V2,
  PROMOTION_ENGINE_V2,
  type PricingPolicySnapshot,
} from "../../../src/domains/commerce/offerPolicyContracts.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceCurrency, CommerceQuote } from "../../../src/domains/commerce/types.js";
import {
  CommerceQuoteError,
  type CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import { COMMERCE_MIN_AUTO_ORDER_UNITS } from "../../../src/domains/commerce/recommendationPolicyDeps.js";
import { MINIMUM_PRODUCT_PAYABLE_MINOR } from "./promotionCodePreview.js";
import type {
  CommerceQuoteCatalogItem,
  CommerceQuoteCatalogReadPort,
} from "./commerceQuoteCatalogReadPort.js";

/**
 * Why one product was left out of the offer projection.
 *
 * The projection's `minimumBy` produces the customer-facing "from" figure, so a
 * silently shrunken product set would advertise a price that is not the real
 * minimum. A dropped product cannot pull that minimum DOWN - the reachable error
 * is always a HIGHER advertised price, never an undersell - but it must still be
 * legible, so every exclusion is recorded. The response contract deliberately
 * does not move: this is the whole signal.
 *
 * Private, bounded operational fact; no request or customer data.
 */
interface OfferPricingExclusionDiagnostic {
  event: "commerce_offer_pricing_product_excluded";
  product_slug: string;
  refusal_code: string;
}

function recordOfferPricingExclusion(diagnostic: OfferPricingExclusionDiagnostic): void {
  try {
    console.info(JSON.stringify(diagnostic));
  } catch {
    // A private diagnostic sink must never alter the projection it observes.
  }
}

/** Representative first package cadence; pricing remains per-unit/product-only. */
export const OFFER_PROJECTION_CADENCE_DAYS = 14;

export interface CommerceOfferPricingDeps {
  quoteCatalogReadPort: CommerceQuoteCatalogReadPort;
  quoteWithPromotions: CommerceQuotePort;
  quoteWithoutPromotions: CommerceQuotePort;
  pricingPolicy?: PricingPolicySnapshot;
}

/**
 * Product-only acquisition projection over the same quote ports used by
 * configurator checkout. It never prices delivery and is never accepted as a
 * checkout expectation; its only consumer is non-transactional "from" copy.
 */
export async function projectCommerceOfferPricing({
  quoteCatalogReadPort,
  quoteWithPromotions,
  quoteWithoutPromotions,
  pricingPolicy,
}: CommerceOfferPricingDeps): Promise<CommerceOfferPricingResponse> {
  const products = (await quoteCatalogReadPort.listQuoteCatalogItems()).filter(isOfferProduct);
  if (products.length === 0) throw new Error("commerce_offer_pricing_unavailable");

  const settled = await Promise.all(
    products.map(async (product) => {
      try {
        return {
          product,
          entry: await projectProduct(
            product, quoteWithPromotions, quoteWithoutPromotions, pricingPolicy,
          ),
        };
      } catch (error) {
        // One SKU the strict money authority cannot price must not remove every
        // PDP price block. Only that refusal degrades; an infrastructure failure
        // or a violated pricing invariant still refuses the whole projection.
        if (error instanceof CommerceQuoteError && error.code === "PRICE_NOT_CONFIGURED") {
          recordOfferPricingExclusion({
            event: "commerce_offer_pricing_product_excluded",
            product_slug: product.productSlug,
            refusal_code: typeof error.details.reason === "string" ? error.details.reason : "unknown",
          });
          return null;
        }
        throw error;
      }
    }),
  );
  const priced = settled.flatMap((outcome) => (outcome ? [outcome] : []));
  const projected = priced.map((outcome) => outcome.entry);
  // The minimum below is the customer-facing "from" figure. Over an EMPTY set it
  // would be meaningless, so a projection that priced nothing refuses exactly as
  // an empty catalogue does rather than answering with an invented floor.
  if (projected.length === 0) throw new Error("commerce_offer_pricing_unavailable");
  const oneTime = minimumBy(projected, (entry) => entry.oneTime.unitGross.amountMinor);
  const subscription = minimumBy(
    projected,
    (entry) => entry.subscriptionInitial.unitGross.amountMinor,
  );

  const legacy = {
    contractVersion: COMMERCE_OFFER_PRICING_CONTRACT_VERSION,
    scope: "dog_products_only_excludes_shipping",
    products: projected,
    minimum: { oneTime, subscription },
  } as const;
  if (pricingPolicy?.offerPolicyVersion !== OFFER_POLICY_V2 ||
      pricingPolicy.promotionEngineVersion !== PROMOTION_ENGINE_V2) return legacy;

  // The representative quote must come from a product that actually PRICED. Using
  // the catalogue's first product would re-raise the very refusal just excluded
  // and refuse the whole response - the batch failure this wave exists to remove.
  const representative = await quoteWithPromotions.createQuote(
    requestFor(priced[0]!.product, "one_time"),
    pricingPolicy ? { pricingPolicy } : undefined,
  );
  // An absent shipping figure is zero in the currency the quote came back in.
  // It used to be zero in a named currency, which is a coercion rather than a
  // default: a quote in one currency would have carried a shipping line in
  // another, and the two would have been summed.
  const quoteCurrency = representative.quote.currency;
  const gross = representative.quote.shippingGross ?? { amountMinor: 0, currency: quoteCurrency };
  const discountGross = representative.quote.shippingDiscountGross
    ?? { amountMinor: 0, currency: quoteCurrency };
  return {
    contractVersion: COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION,
    scope: "dog_products_and_shipping",
    pricingPolicy,
    products: projected,
    minimum: { oneTime, subscription },
    shipping: {
      gross,
      discountGross,
      payable: { amountMinor: gross.amountMinor - discountGross.amountMinor, currency: gross.currency },
    },
    // Both halves now come from the settlement profile: E2-F2 unpinned the
    // denomination and left the amount, which was one major unit written out as
    // a hundredths-assuming literal.
    minimumProductPayable: {
      amountMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
      currency: quoteCurrency,
    },
  };
}

function isOfferProduct(product: CommerceQuoteCatalogItem): boolean {
  return (
    product.species === "dog" &&
    product.isPrimarySku === true &&
    product.isAddon !== true &&
    product.sellability.oneTime &&
    product.sellability.subscription
  );
}

async function projectProduct(
  product: CommerceQuoteCatalogItem,
  quoteWithPromotions: CommerceQuotePort,
  quoteWithoutPromotions: CommerceQuotePort,
  pricingPolicy?: PricingPolicySnapshot,
): Promise<CommerceProductOfferPricing> {
  const options = pricingPolicy ? { pricingPolicy } : undefined;
  const [oneTime, subscriptionInitial, subscriptionRecurring] = await Promise.all([
    quoteWithPromotions.createQuote(requestFor(product, "one_time"), options),
    quoteWithPromotions.createQuote(requestFor(product, "subscription"), options),
    quoteWithoutPromotions.createQuote(requestFor(product, "subscription"), options),
  ]);
  const oneTimeProductGross = productGross(oneTime.quote);
  const initialProductGross = productGross(subscriptionInitial.quote);
  const recurringProductGross = productGross(subscriptionRecurring.quote);
  const anchorUnitGross = oneTime.quote.lines[0]?.unitPriceGross;
  if (!anchorUnitGross) throw new Error("commerce_offer_pricing_line_missing");
  const anchorPackageGross =
    anchorUnitGross.amountMinor * COMMERCE_MIN_AUTO_ORDER_UNITS;

  return {
    productSlug: product.productSlug,
    unitCount: COMMERCE_MIN_AUTO_ORDER_UNITS,
    oneTime: price(oneTimeProductGross, oneTime.quote.currency),
    subscriptionInitial: price(initialProductGross, subscriptionInitial.quote.currency),
    subscriptionRecurring: price(
      recurringProductGross,
      subscriptionRecurring.quote.currency,
    ),
    catalogAnchorUnitGross: anchorUnitGross,
    initialDiscountPercent: discountPercent(anchorPackageGross, initialProductGross),
    recurringDiscountPercent: discountPercent(anchorPackageGross, recurringProductGross),
  };
}

function requestFor(
  product: CommerceQuoteCatalogItem,
  mode: "one_time" | "subscription",
): CreateQuoteRequest {
  return {
    mode,
    lines: [
      {
        sku: product.skuCode,
        variantId: product.variantId,
        quantity: COMMERCE_MIN_AUTO_ORDER_UNITS,
        modeAtLine: mode,
      },
    ],
    ...(mode === "subscription"
      ? { cadenceDays: OFFER_PROJECTION_CADENCE_DAYS }
      : {}),
    promoCodes: [],
  };
}

function productGross(quote: CommerceQuote): number {
  return quote.subtotalGross.amountMinor - quote.discountTotalGross.amountMinor;
}

// Carries whatever currency the quote came back in; it is not this helper's job
// to name one (src/lib/currency/platformCurrency.ts owns that question).
function price(amountMinor: number, currency: CommerceCurrency) {
  return {
    packageGross: { amountMinor, currency },
    unitGross: {
      amountMinor: Math.round(amountMinor / COMMERCE_MIN_AUTO_ORDER_UNITS),
      currency,
    },
  };
}

function discountPercent(anchorMinor: number, effectiveMinor: number): number {
  if (anchorMinor <= 0 || effectiveMinor >= anchorMinor) return 0;
  return Math.round(((anchorMinor - effectiveMinor) / anchorMinor) * 100);
}

function minimumBy(
  entries: CommerceProductOfferPricing[],
  amount: (entry: CommerceProductOfferPricing) => number,
): CommerceProductOfferPricing {
  return entries.reduce((minimum, entry) =>
    amount(entry) < amount(minimum) ? entry : minimum,
  );
}
