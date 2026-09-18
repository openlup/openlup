import { useTranslation } from "react-i18next";

import { formatMoney } from "./configuratorPricing";
import type { RecommendationBundleSummary } from "@/checkout/machine/recommendationGate";

/**
 * Pod-komponent karty „Twój pakiet" ({@link ./BundleSummary}): drabinka ceny.
 *
 * Reszta tego modułu (ReasonList, ExcludedProducts, CondensedPackageRecap,
 * PersonalNarrative) zniknęła razem ze zdaniami, które krok 6 tłumaczył
 * klientowi zamiast je pokazywać — nic ich już nie montowało.
 */

/**
 * The price ladder shows catalog price → product discount → products after
 * discount → delivery → „Razem dziś" as the one large amount.
 *
 * ⚠️ `aria-live` invariant, scoped to this ladder: EXACTLY ONE live region
 * announces an AMOUNT, and it is always `order-total-amount` — the sum actually
 * charged. Every other amount here (the struck anchor, the savings) is context
 * for it, and a second live amount would make one stepper click read two prices
 * aloud. The surrounding card legitimately has other live regions — the mix
 * editor announces each flavour's quantity — so the invariant is about money,
 * not about the card containing a single `aria-live` node.
 *
 * `compact` remains a compatibility prop for the mobile caller. Both breakpoints
 * intentionally render the same monetary rows: a waived delivery must not be
 * folded into the product discount.
 */
export function BundlePriceBreakdown({
  productSavingsMinor,
  productPayableMinor,
  shippingGrossMinor,
  shippingDiscountMinor,
  totalCans,
  totalPriceMinor,
  anchorPriceMinor,
  startDiscountPercent = null,
  priceText,
  lang,
}: {
  /** Complete product saving against the crossed-out base product price. */
  productSavingsMinor?: number;
  /** Customer-facing payable amount for products only, excluding delivery. */
  productPayableMinor: number | null;
  shippingGrossMinor?: number | null;
  shippingDiscountMinor: number;
  totalCans: number;
  totalPriceMinor: number | null;
  anchorPriceMinor?: number | null;
  /** Starter first-delivery discount (whole percent) from the quote, never a literal. */
  startDiscountPercent?: number | null;
  priceText: string;
  compact?: boolean;
  lang: "en" | "pl";
}) {
  const { t } = useTranslation("checkout");
  const hasShipping = shippingGrossMinor != null && shippingGrossMinor > 0;
  const shippingIsFree = hasShipping && shippingDiscountMinor >= shippingGrossMinor;
  const hasResolvedProductPrice = productPayableMinor != null;
  const showAnchor =
    hasResolvedProductPrice && anchorPriceMinor != null && anchorPriceMinor > productPayableMinor;
  const anchorText = anchorPriceMinor != null ? formatMoney(anchorPriceMinor, lang) : null;
  const hasPercent = startDiscountPercent != null && startDiscountPercent > 0;
  const savingsMinor = productSavingsMinor != null && productSavingsMinor > 0 ? productSavingsMinor : 0;

  return (
    <div className="mt-6 space-y-2.5 border-t border-cfg-ink/12 pt-5 md:mt-7">
      {showAnchor ? (
        <div
          data-testid="product-catalog-row"
          className="flex items-baseline justify-between font-body text-sm-plus text-cfg-ink/70"
        >
          <span>{t("checkout:step5.summaryCans", { count: totalCans })}</span>
          <span data-testid="product-catalog-amount" className="text-cfg-ink/45 line-through">
            {anchorText}
          </span>
        </div>
      ) : null}

      {savingsMinor > 0 && (
        <div
          data-testid="order-discount-row"
          className="flex items-baseline justify-between font-body text-sm-plus text-accent-teal"
        >
          <span>
            {hasPercent
              ? t("checkout:step5.startDiscountLabel", { percent: startDiscountPercent })
              : t("checkout:step5.productDiscountLabel")}
          </span>
          <span className="font-semibold">−{formatMoney(savingsMinor, lang)}</span>
        </div>
      )}

      {/* „Produkty po rabacie" only earns a row when it differs from „Razem dziś".
          With free delivery — the standing state — it repeated the total two lines
          below it, so the ladder said the same number twice and the eye stopped
          trusting either. Without an anchor this row is the plain can line and
          always renders. */}
      {(!showAnchor || (hasShipping && !shippingIsFree)) && (
        <div
          data-testid="product-payable-row"
          className="flex items-baseline justify-between font-body text-sm-plus text-cfg-ink/70"
        >
          <span>
            {showAnchor
              ? t("checkout:step5.productsAfterDiscount")
              : t("checkout:step5.summaryCans", { count: totalCans })}
          </span>
          <span data-testid="product-payable-amount">
            {hasResolvedProductPrice ? formatMoney(productPayableMinor, lang) : priceText}
          </span>
        </div>
      )}

      {hasShipping && (
        <div
          data-testid="shipping-row"
          className="flex items-baseline justify-between font-body text-sm-plus"
        >
          <span className={shippingIsFree ? "text-accent-teal" : "text-cfg-ink/70"}>
            {t("checkout:step5.shippingLabel")}
          </span>
          {shippingIsFree ? (
            <span className="font-semibold uppercase text-accent-teal">
              {t("checkout:step5.shippingFree")}
            </span>
          ) : (
            <span className="text-cfg-ink/85">
              {formatMoney(shippingGrossMinor - shippingDiscountMinor, lang)}
            </span>
          )}
        </div>
      )}

      <div
        data-testid="order-total-row"
        className="flex items-baseline justify-between gap-3 pt-2"
      >
        <span className="font-display font-semibold text-base-plus text-cfg-ink md:text-xl">
          {t("checkout:step5.summaryTotalToday")}
        </span>
        <span className="flex flex-none items-baseline gap-2 whitespace-nowrap">
          <span
            data-testid="order-total-amount"
            aria-live="polite"
            className={
              totalPriceMinor != null
                ? "font-display font-bold text-2xl-plus leading-none text-cfg-ink md:text-3xl-plus"
                : "font-body text-xs-plus text-cfg-ink"
            }
          >
            {priceText}
          </span>
        </span>
      </div>
    </div>
  );
}
