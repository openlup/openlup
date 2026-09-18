import { estimateDeliveryWindow, type DeliveryDispatchPolicy } from "@/domains/subscription/deliveryEstimate";
import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";
import {
  STARTER_DELIVERY2_DISCOUNT_BPS,
  starterAggregateBySku,
  starterDelivery2TargetMinor,
  starterRescaleBasket,
  starterTermsFromCoverage,
} from "@/domains/commerce/starterOfferPolicy";

import {
  quoteModeDiscountPercent,
  quotePerUnitAnchorMinor,
  quoteProductPayableMinor,
  type CommerceQuote,
} from "./useLiveQuote";

/**
 * Band-only pricing, and the starter offer's display numbers built from it.
 *
 * Lives beside `useLiveQuote` rather than inside it because that module is at
 * its size cap; more importantly, everything here is a pure function of a quote
 * (plus, for the delivery-2 date, an explicit "now"), so it is unit-testable
 * without React, a clock or a network.
 */

const DAY_MS = 86_400_000;

/**
 * What the SAME basket costs at plain subscription-band prices — the anchor plus
 * the (negative) `mode_discount` band component, and nothing else.
 *
 * This is the number the "potem" line must show. `quoteProductPayableMinor`
 * would be wrong there: on an acquisition quote it still carries the first-order
 * promotion, so a customer would be told their steady price is the introductory
 * one. Order-scoped components win when the quote emits them, exactly as
 * `quotePerUnitAnchorMinor` does, otherwise the per-line ones are summed.
 *
 * Returns `null` when the quote carries no anchor at all (legacy snapshots), so
 * callers omit the figure rather than render a fabricated one.
 */
export function quoteBandPayableMinor(quote: CommerceQuote): number | null {
  const anchor = quotePerUnitAnchorMinor(quote);
  if (anchor <= 0) return null;
  const order = sumComponent(quote.pricingComponents, "mode_discount");
  const modeDiscount = order !== 0
    ? order
    : quote.lines.reduce(
        (sum, line) => sum + sumComponent(line.pricingComponents, "mode_discount"),
        0,
      );
  // `mode_discount` is signed negative; adding it is the band price.
  return Math.max(0, anchor + modeDiscount);
}

export interface StarterOfferMoneyInput {
  /** Live quote of the acquisition basket (delivery 1). */
  starterQuote: CommerceQuote | null;
  /**
   * Live quote of the cadence-`steadyCadenceDays` package the plan graduates to.
   * Absent when that quote has not resolved — the "potem" money line is then
   * omitted rather than guessed.
   */
  steadyQuote: CommerceQuote | null;
  /** Days between the delivery-1 payment and the delivery-2 charge. */
  intervalDays: number;
  steadyCadenceDays: number;
  /** Caller-supplied "now". Keeps this function pure and its tests clock-stable. */
  nowIso: string;
  /** Line γ seam: market dispatch timetable from the composition root; undefaulted by design (A3, PR 2383). `null` drops the estimate. */ dispatchPolicy: DeliveryDispatchPolicy | null;
}

export interface StarterOfferMoney {
  /** Primary number: what delivery 1 works out to per day. */
  firstPerDayMinor: number | null;
  /** Struck-through comparison: the same basket per day at catalog list prices. */
  firstAnchorPerDayMinor: number | null;
  /** Whole-percent saving on delivery 1, from the quote (never a hard-coded 50). */
  firstDiscountPercent: number | null;
  /** Total charged for delivery 2: the same basket at −35% off the list anchor. */
  delivery2TotalMinor: number | null;
  /** Estimated ARRIVAL day for delivery 2. Always rendered as an approximation. */
  delivery2EstimateIso: string | null;
  /** Per-day price from delivery 3 on, at plain band prices. */
  steadyPerDayMinor: number | null;
  /** Whole-percent band saving from delivery 3 on. */
  steadyDiscountPercent: number | null;
}

/**
 * Assembles every number the single-offer block renders.
 *
 * Each field resolves independently and to `null` when its input is missing, so
 * a slow or failed steady quote costs the customer the "potem" line and nothing
 * else — the offer they are looking at never disappears once shown.
 */
export function starterOfferMoney(input: StarterOfferMoneyInput): StarterOfferMoney {
  const { starterQuote, steadyQuote, intervalDays, steadyCadenceDays, nowIso, dispatchPolicy } = input;
  const anchorMinor = starterQuote ? quotePerUnitAnchorMinor(starterQuote) : 0;
  const payableMinor = starterQuote ? quoteProductPayableMinor(starterQuote) : null;
  const usableInterval = intervalDays > 0 ? intervalDays : null;
  const steadyBandMinor = steadyQuote ? quoteBandPayableMinor(steadyQuote) : null;

  return {
    firstPerDayMinor:
      payableMinor != null && usableInterval ? Math.round(payableMinor / usableInterval) : null,
    firstAnchorPerDayMinor:
      anchorMinor > 0 && usableInterval && payableMinor != null && anchorMinor > payableMinor
        ? Math.round(anchorMinor / usableInterval)
        : null,
    firstDiscountPercent:
      starterQuote && anchorMinor > 0 && payableMinor != null && anchorMinor > payableMinor
        ? Math.round(((anchorMinor - payableMinor) / anchorMinor) * 100)
        : null,
    // −35% off the catalog LIST anchor of the same lines. Deliberately the same
    // helper the checkout guard prices delivery 2 with, so the promise on screen
    // and the amount frozen into the subscription marker are one formula.
    delivery2TotalMinor: anchorMinor > 0 ? starterDelivery2TargetMinor(anchorMinor) : null,
    delivery2EstimateIso: usableInterval
      ? estimatedArrivalIso(nowIso, usableInterval, dispatchPolicy)
      : null,
    steadyPerDayMinor:
      steadyBandMinor != null && steadyCadenceDays > 0
        ? Math.round(steadyBandMinor / steadyCadenceDays)
        : null,
    steadyDiscountPercent: steadyQuote ? quoteModeDiscountPercent(steadyQuote) : null,
  };
}

/**
 * Everything the starter-pack surfaces render: the plan's shape (how many cans,
 * how far apart, what it graduates to) plus its money.
 *
 * The shape is computed from the same `starterOfferPolicy` functions the
 * checkout guard recomputes with and `buildCheckoutIntent` declares from, so the
 * customer is shown the terms that will actually be asked for — not an
 * independently-derived approximation of them.
 */
export interface StarterPlanView extends StarterOfferMoney {
  cans: number;
  intervalDays: number;
  steadyCadenceDays: 14 | 28;
  steadyCans: number;
}

export interface StarterPlanViewInput {
  /** The EFFECTIVE acquisition package (baseline plus customer quantity edits). */
  snapshot: CommerceRecommendationSnapshot | null;
  /** Live quote of that package. Also the sole source of the offer's terms. */
  starterQuote: CommerceQuote | null;
  /**
   * Live quote of the RESCALED graduation basket — the same lines, at the same
   * cadence, that the checkout guard prices and freezes into the marker. NOT a
   * generic cadence quote: after a step-6 mix edit with unequal flavour prices
   * the default mix and the customer's own mix cost different amounts, and the
   * "potem" line must state the one that will actually be charged.
   */
  steadyQuote: CommerceQuote | null;
  nowIso: string;
  /** Line γ seam: see {@link StarterOfferMoneyInput}. */ dispatchPolicy: DeliveryDispatchPolicy | null;
}

/**
 * `null` when the plan does not resolve — no ration, or a basket too small to be
 * a starter pack. Surfaces render nothing rather than a partial promise.
 */
export function starterPlanView(input: StarterPlanViewInput): StarterPlanView | null {
  const { snapshot, starterQuote, steadyQuote, nowIso, dispatchPolicy } = input;
  if (!snapshot) return null;
  const cans = snapshot.lines.reduce((sum, line) => sum + line.qty, 0);
  // Terms come from the QUOTE's coverage, exactly as the checkout guard derives
  // them — never from `snapshot.dailyGrams`. The number on screen is therefore
  // the number that will be asked for and the number that will be accepted.
  const terms = starterTermsFromCoverage(cans, starterQuote?.context?.feedingCoverageDays);
  if (terms === null) return null;
  return {
    cans,
    intervalDays: terms.intervalDays,
    steadyCadenceDays: terms.cadenceDays,
    steadyCans: terms.steadyCans,
    ...starterOfferMoney({
      starterQuote,
      steadyQuote,
      intervalDays: terms.intervalDays,
      steadyCadenceDays: terms.cadenceDays,
      nowIso,
      dispatchPolicy,
    }),
  };
}

/**
 * The graduation basket the subscription will actually be given: the customer's
 * OWN mix, folded by SKU and rescaled to the steady size — byte-for-byte the
 * transformation `resolveStarterOfferGuard` applies before it prices and freezes
 * the marker (`starterAggregateBySku` then `starterRescaleBasket`, both reused
 * here verbatim rather than reimplemented).
 *
 * `null` when the offer does not resolve, or when the rescale cannot land on the
 * target — more distinct flavours than cans is unrepresentable once each is owed
 * one, and 2385's contract is that a caller must treat that as a rejection, not
 * as a plan. The caller then shows quantity and cadence with no amount, rather
 * than an amount for a basket nobody will be charged for.
 */
export function starterSteadyBasket(
  snapshot: CommerceRecommendationSnapshot | null,
  starterQuote: CommerceQuote | null,
): { snapshot: CommerceRecommendationSnapshot; cadenceDays: 14 | 28 } | null {
  if (!snapshot) return null;
  const cans = snapshot.lines.reduce((sum, line) => sum + line.qty, 0);
  const terms = starterTermsFromCoverage(cans, starterQuote?.context?.feedingCoverageDays);
  if (terms === null) return null;
  const lines = starterRescaleBasket(starterAggregateBySku(snapshot.lines), terms.steadyCans);
  if (lines.reduce((sum, line) => sum + line.qty, 0) !== terms.steadyCans) return null;
  return {
    snapshot: { ...snapshot, lines, cadenceDays: terms.cadenceDays },
    cadenceDays: terms.cadenceDays,
  };
}

/** One rendered sentence of the plan: an i18n key plus its interpolations. */
export interface StarterPlanLine {
  i18nId: string;
  testId?: string;
  params: Record<string, string | number>;
}

/**
 * The plan's sentences, chosen from what actually resolved.
 *
 * Copy selection lives here, next to the numbers, so it is unit-testable without
 * a renderer and so the three surfaces that show the plan cannot drift into
 * three different wordings. A line whose money is missing degrades to its
 * priceless variant or is dropped — never rendered with a placeholder amount.
 */
export function starterPlanLines(
  plan: StarterPlanView,
  formatMoney: (amountMinor: number) => string,
  formatDay: (iso: string) => string,
): StarterPlanLine[] {
  const lines: StarterPlanLine[] = [];
  if (plan.delivery2TotalMinor != null) {
    lines.push({
      i18nId: plan.delivery2EstimateIso
        ? "checkout:step4.starter.delivery2"
        : "checkout:step4.starter.delivery2NoDate",
      testId: "starter-delivery-2",
      params: {
        days: plan.intervalDays,
        amount: formatMoney(plan.delivery2TotalMinor),
        percent: STARTER_DELIVERY2_DISCOUNT_BPS / 100,
        ...(plan.delivery2EstimateIso ? { date: formatDay(plan.delivery2EstimateIso) } : {}),
      },
    });
  }
  lines.push(
    plan.steadyPerDayMinor != null && plan.steadyDiscountPercent != null
      ? {
          i18nId: "checkout:step4.starter.steadyLine",
          testId: "starter-steady",
          params: {
            count: plan.steadyCans,
            days: plan.steadyCadenceDays,
            perDay: formatMoney(plan.steadyPerDayMinor),
            percent: plan.steadyDiscountPercent,
          },
        }
      : {
          i18nId: "checkout:step4.starter.steadyLineNoPrice",
          testId: "starter-steady",
          params: { count: plan.steadyCans, days: plan.steadyCadenceDays },
        },
  );
  lines.push({ i18nId: "checkout:step4.starter.flexibility", params: {} });
  return lines;
}

/**
 * Latest estimated ARRIVAL day for a charge `intervalDays` from `nowIso`.
 *
 * The later end of the window is used on purpose: this is an under-promise, and
 * the copy labels it as an estimate. `null` when the input cannot be parsed —
 * the line is then dropped rather than shown with a wrong date.
 */
function estimatedArrivalIso(nowIso: string, intervalDays: number, dispatchPolicy: DeliveryDispatchPolicy | null): string | null {
  if (!dispatchPolicy) return null;
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return null;
  const chargeIso = new Date(now.getTime() + intervalDays * DAY_MS).toISOString();
  return estimateDeliveryWindow(chargeIso, dispatchPolicy)?.toIso ?? null;
}

function sumComponent(
  components: CommerceQuote["pricingComponents"],
  type: string,
): number {
  return (components ?? [])
    .filter((component) => component.componentType === type)
    .reduce((sum, component) => sum + (component.amountMinor ?? 0), 0);
}
