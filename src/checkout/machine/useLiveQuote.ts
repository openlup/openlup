import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCommerceQuote } from "@/domains/commerce/commerceClient";
import type { CreateQuoteResponse } from "@/domains/commerce/contracts";
import { createRequestCache } from "./commerceRequestCache";
import { missingRequiredPromotionAcceptance, semanticQuoteRequestKey } from "./promotionAcceptanceClient";
import { buildQuoteRequest, type LiveQuoteInput } from "./useLiveQuoteRequest";
export { buildQuoteRequest, normalizeQuoteEligibilityEmail } from "./useLiveQuoteRequest";
export type { LiveQuoteInput } from "./useLiveQuoteRequest";

/**
 * Live server price for the configurator summary.
 *
 * Reads the authoritative `POST /api/bff/commerce/quote` total so the price, discounts
 * and caps all come from one source of truth. Mirrors the loading/error
 * shape of `useCommerceRecommendations`; code changes are debounced and stale
 * consumers detach on change/unmount while an identical request remains shared.
 */

export type CommerceQuote = CreateQuoteResponse["quote"] & { promotionAcceptanceToken?: string };
export type QuoteDiscount = CommerceQuote["discounts"][number];

export const DEBOUNCE_MS = 500;

/**
 * Session-scoped quote cache, shared with {@link useLengthQuotes} so a price
 * resolved on the length step is reused on the summary (and vice versa) without
 * a second round-trip. Keyed by the full request payload.
 */
export const quoteCache = createRequestCache<CommerceQuote>();

function cachedQuoteMatchesAcceptance(
  quote: CommerceQuote,
  requestedToken: string | null | undefined,
): boolean {
  if (requestedToken) return quote.promotionAcceptanceToken === requestedToken;
  return !missingRequiredPromotionAcceptance(quote);
}

export interface LiveQuoteState {
  loading: boolean;
  error: string | null;
  quote: CommerceQuote | null;
  /** Replays the exact current semantic request after a transient quote failure. */
  retry: () => void;
}

interface KeyedLiveQuoteState extends Omit<LiveQuoteState, "retry"> {
  requestKey: string | null;
}

export function useLiveQuote(input: LiveQuoteInput): LiveQuoteState {
  const {
    snapshot, subscription, lengthDays, promoCodes, customerEmail,
    pricingPolicyToken, promotionAcceptanceToken, enabled = true,
  } = input;
  // Key on code *content*, not the array identity, so a re-render that passes a
  // fresh-but-equal `promoCodes` array does not retrigger the fetch effect.
  const promoKey = promoCodes.join("");
  const request = useMemo(
    () =>
      enabled
        ? buildQuoteRequest({
            snapshot, subscription, lengthDays, promoCodes, customerEmail,
            pricingPolicyToken, promotionAcceptanceToken,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- promoKey tracks promoCodes content
    [snapshot, subscription, lengthDays, promoKey, customerEmail, pricingPolicyToken, promotionAcceptanceToken, enabled],
  );
  const currentRequestKey = request ? semanticQuoteRequestKey(request) : null;
  const [state, setState] = useState<KeyedLiveQuoteState>({
    loading: false,
    error: null,
    quote: null,
    requestKey: null,
  });
  const [retryEpoch, setRetryEpoch] = useState(0);
  const loadingRef = useRef(false);
  const retryScheduledRef = useRef(false);
  const retry = useCallback(() => {
    if (loadingRef.current || retryScheduledRef.current) return;
    retryScheduledRef.current = true;
    setRetryEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    retryScheduledRef.current = false;
    if (!request) {
      loadingRef.current = false;
      setState({ loading: false, error: null, quote: null, requestKey: null });
      return;
    }

    // Identical request already priced this session → resolve instantly, no
    // debounce and no network (the "ekspres" path when nothing changed).
    const key = semanticQuoteRequestKey(request);
    const cached = quoteCache.get(key);
    if (cached && cachedQuoteMatchesAcceptance(cached, promotionAcceptanceToken)) {
      loadingRef.current = false;
      setState({ loading: false, error: null, quote: cached, requestKey: key });
      return;
    }

    let active = true;
    const controller = new AbortController();
    loadingRef.current = true;
    setState({ loading: true, error: null, quote: null, requestKey: key });

    const timer = setTimeout(() => {
      const settled = quoteCache.get(key);
      if (settled && cachedQuoteMatchesAcceptance(settled, promotionAcceptanceToken)) {
        if (active) {
          loadingRef.current = false;
          setState({ loading: false, error: null, quote: settled, requestKey: key });
        }
        return;
      }

      createCommerceQuote(request, { signal: controller.signal })
        .then((response) => {
          if (!active || controller.signal.aborted) return;
          const quote = response.promotionAcceptanceToken
            ? { ...response.quote, promotionAcceptanceToken: response.promotionAcceptanceToken }
            : response.quote;
          quoteCache.set(key, quote);
          loadingRef.current = false;
          setState({ loading: false, error: null, quote, requestKey: key });
        })
        .catch((error: unknown) => {
          if (!active) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          loadingRef.current = false;
          setState({
            loading: false,
            error: "checkout:step5.liveQuoteError",
            quote: null,
            requestKey: key,
          });
        });
    }, DEBOUNCE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, retryEpoch]);

  // Effects run after render. Never expose the previous request's quote during
  // that gap: checkout expectation and wallet amount must be keyed to the exact
  // inputs currently on screen.
  if (state.requestKey !== currentRequestKey) {
    return currentRequestKey
      ? { loading: true, error: null, quote: null, retry }
      : { loading: false, error: null, quote: null, retry };
  }
  return { ...state, retry };
}

/**
 * Per-unit anchor = sum of `base_unit` pricing components (order-scoped when
 * present, otherwise summed from each line). Represents the undiscounted
 * "price per single unit" total the resolved total is compared against.
 */
export function quotePerUnitAnchorMinor(quote: CommerceQuote): number {
  const orderBase = sumBaseUnit(quote.pricingComponents);
  if (orderBase > 0) return orderBase;
  return quote.lines.reduce((sum, line) => sum + sumBaseUnit(line.pricingComponents), 0);
}

/** Customer-facing product total with paid shipping removed. */
export function quoteProductPayableMinor(quote: CommerceQuote): number {
  const shippingGross = Math.max(0, quote.shippingGross?.amountMinor ?? 0);
  const shippingDiscount = Math.max(0, quote.shippingDiscountGross?.amountMinor ?? 0);
  const paidShipping = Math.max(0, shippingGross - shippingDiscount);
  return Math.max(0, quote.totalGross.amountMinor - paidShipping);
}

/**
 * The only monetary saving shown in checkout: the complete product saving
 * against the crossed-out product anchor. Delivery is a separate benefit and
 * must never inflate this amount.
 *
 * Older quote snapshots may not carry `base_unit` components. In that case the
 * server-authored product discount total is the safe display fallback, so a
 * successfully applied discount never disappears merely because the legacy
 * anchor is absent.
 */
export function quoteProductSavingsMinor(quote: CommerceQuote): number {
  const anchor = quotePerUnitAnchorMinor(quote);
  if (anchor > 0) return Math.max(0, anchor - quoteProductPayableMinor(quote));
  return Math.max(0, quote.discountTotalGross?.amountMinor ?? 0);
}

/**
 * Recurring subscription-band discount as a whole-percent off the per-unit anchor
 * — the "od każdej dostawy" rate. Derived from the signed `mode_discount`
 * pricing component (negative), so it reflects whatever the price band actually
 * applies, never a hard-coded marketing number. Returns null when there is no
 * subscription band (e.g. a one-time quote, or the static fallback resolver),
 * so callers can omit the figure rather than show a fictional one.
 */
export function quoteModeDiscountPercent(quote: CommerceQuote): number | null {
  const anchor = quotePerUnitAnchorMinor(quote);
  if (anchor <= 0) return null;
  const modeDiscount = sumModeDiscount(quote);
  if (modeDiscount >= 0) return null;
  const percent = Math.round((-modeDiscount / anchor) * 100);
  return percent > 0 ? percent : null;
}

/**
 * Effective discount applied to THIS order as a whole-percent off the per-unit
 * anchor — the recurring subscription band PLUS any order-scoped promos/codes
 * (first-order eligibility promos, coupons). This is what the customer actually
 * saves on the order in front of them, so a marketing headline derived from it
 * matches the price charged. Returns null when nothing is discounted, so callers
 * omit the figure rather than show 0%.
 *
 * Sums the (negative) `mode_discount` band component plus the resolved
 * `discounts[]` amounts — NOT a `promo` pricing component, because the live BFF
 * quote carries promos/codes only in `discounts[]` (no `promo` component is
 * emitted). Summing components alone silently dropped every promo and collapsed
 * the figure to the band.
 *
 * Shipping discounts (`appliesTo === "shipping"`, e.g. free delivery) are excluded
 * from the numerator: the anchor is product-only, so folding the delivery saving in
 * would inflate the headline (a 55% product discount + free 15 zł shipping rendered
 * as a fictional −62%). Free delivery is communicated separately ("Dostawa GRATIS").
 */
export function quoteEffectiveDiscountPercent(quote: CommerceQuote): number | null {
  const anchor = quotePerUnitAnchorMinor(quote);
  if (anchor <= 0) return null;
  const discountMinor = -sumModeDiscount(quote) + sumDiscountsAmountOffMinor(quote);
  if (discountMinor <= 0) return null;
  const percent = Math.round((discountMinor / anchor) * 100);
  return percent > 0 ? percent : null;
}

/** Codes were submitted but the server resolved no discounts (invalid/expired). */
export function isInvalidPromoResult(
  quote: CommerceQuote | null,
  promoCodes: string[],
): boolean {
  return quote !== null && promoCodes.length > 0 && quote.discounts.length === 0;
}

function sumBaseUnit(components: CommerceQuote["pricingComponents"]): number {
  return (components ?? [])
    .filter((component) => component.componentType === "base_unit")
    .reduce((sum, component) => sum + (component.amountMinor ?? 0), 0);
}

/** Sum the (negative) `mode_discount` components, order-scoped when present, else per-line. */
function sumModeDiscount(quote: CommerceQuote): number {
  const order = sumComponentType(quote.pricingComponents, "mode_discount");
  if (order !== 0) return order;
  return quote.lines.reduce(
    (sum, line) => sum + sumComponentType(line.pricingComponents, "mode_discount"),
    0,
  );
}

/**
 * Sum the resolved product promo/code discount amounts (positive minor units)
 * from `discounts[]`, excluding shipping discounts (`appliesTo === "shipping"`)
 * so a free-delivery saving never inflates the product-discount percentage.
 */
function sumDiscountsAmountOffMinor(quote: CommerceQuote): number {
  return (quote.discounts ?? [])
    .filter((discount) => discount.appliesTo !== "shipping")
    .reduce((sum, discount) => sum + (discount.amountOffMinor ?? 0), 0);
}

function sumComponentType(
  components: CommerceQuote["pricingComponents"],
  type: string,
): number {
  return (components ?? [])
    .filter((component) => component.componentType === type)
    .reduce((sum, component) => sum + (component.amountMinor ?? 0), 0);
}
