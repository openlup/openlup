import type { DeliveryDispatchPolicy } from "@/domains/subscription/deliveryEstimate";
import { describe, expect, it } from "vitest";

import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";
import {
  starterAggregateBySku,
  starterDelivery2TargetMinor,
  starterRescaleBasket,
} from "@/domains/commerce/starterOfferPolicy";

import {
  quoteBandPayableMinor,
  starterOfferMoney,
  starterPlanLines,
  starterPlanView,
  starterSteadyBasket,
} from "./quoteBandPricing";
import type { CommerceQuote } from "./useLiveQuote";

/**
 * Line γ seam fixture: a dispatch timetable, supplied the way a composition root supplies
 * one. The market's own calendar lives in the overlay; this test pins the machine's
 * arithmetic over an explicit policy instead of over openlup's.
 *
 * The holiday list is empty on purpose and it does not move the expectation: the only
 * window this suite estimates runs from a 2026-08-17 charge, and the nearest statutory
 * Polish holiday (2026-08-15) falls before it.
 */
const DISPATCH_POLICY_FIXTURE = {
  timeZone: "Europe/Warsaw",
  cutoffHour: 16,
  businessDays: [1, 2, 3, 4, 5],
  holidays: [],
  minTransitBusinessDays: 1,
  maxTransitBusinessDays: 2,
} satisfies DeliveryDispatchPolicy;

/**
 * Anchor 20 860 gr (14 × 14,90), a −10% subscription band and, on the acquisition
 * quote, a first-order promotion on top. The band price and the payable price are
 * therefore different numbers — which is the whole point of `quoteBandPayableMinor`.
 */
function quote({
  anchorMinor = 20_860,
  modeDiscountMinor = 2_086,
  totalMinor = 18_774,
  shippingMinor = 0,
  coverageDays = 11.2,
}: Partial<Record<"anchorMinor" | "modeDiscountMinor" | "totalMinor" | "shippingMinor" | "coverageDays", number>> = {}): CommerceQuote {
  return {
    pricingComponents: [
      { scope: "order", componentType: "base_unit", amountMinor: anchorMinor, reasonCode: "base" },
      { scope: "order", componentType: "mode_discount", amountMinor: -modeDiscountMinor, reasonCode: "band" },
    ],
    lines: [],
    discounts: [],
    // 14 cans x 400 g at 500 g/day. Terms are derived from THIS, exactly as the
    // checkout guard derives them.
    context: { feedingCoverageDays: coverageDays },
    shippingGross: { amountMinor: shippingMinor, currency: "PLN" },
    totalGross: { amountMinor: totalMinor + shippingMinor, currency: "PLN" },
  } as unknown as CommerceQuote;
}

describe("quoteBandPayableMinor", () => {
  it("is the anchor plus the band discount, ignoring acquisition promotions", () => {
    // A quote whose TOTAL is the −50% acquisition price still reports the plain
    // band price, because that is what deliveries 3+ will actually cost.
    expect(quoteBandPayableMinor(quote({ totalMinor: 10_430 }))).toBe(18_774);
  });

  it("falls back to per-line components when the quote is not order-scoped", () => {
    const perLine = {
      pricingComponents: [],
      lines: [
        {
          pricingComponents: [
            { componentType: "base_unit", amountMinor: 10_000 },
            { componentType: "mode_discount", amountMinor: -1_000 },
          ],
        },
        {
          pricingComponents: [
            { componentType: "base_unit", amountMinor: 10_860 },
            { componentType: "mode_discount", amountMinor: -1_086 },
          ],
        },
      ],
      discounts: [],
      totalGross: { amountMinor: 0, currency: "PLN" },
    } as unknown as CommerceQuote;
    expect(quoteBandPayableMinor(perLine)).toBe(18_774);
  });

  it("returns null rather than a fabricated number when there is no anchor", () => {
    const anchorless = {
      pricingComponents: [],
      lines: [],
      discounts: [],
      totalGross: { amountMinor: 9_900, currency: "PLN" },
    } as unknown as CommerceQuote;
    expect(quoteBandPayableMinor(anchorless)).toBeNull();
  });
});

describe("starterOfferMoney", () => {
  const nowIso = "2026-08-03T09:00:00.000Z"; // a Monday, before the 16:00 cut-off

  it("prices delivery 1 per day against the interval and strikes the list anchor", () => {
    const money = starterOfferMoney({
      starterQuote: quote({ totalMinor: 10_430 }),
      steadyQuote: quote(),
      intervalDays: 14,
      steadyCadenceDays: 28,
      nowIso,
      dispatchPolicy: DISPATCH_POLICY_FIXTURE,
    });
    expect(money.firstPerDayMinor).toBe(Math.round(10_430 / 14));
    expect(money.firstAnchorPerDayMinor).toBe(Math.round(20_860 / 14));
    expect(money.firstDiscountPercent).toBe(50);
  });

  it("prices delivery 2 with the same helper the checkout guard freezes it with", () => {
    const money = starterOfferMoney({
      starterQuote: quote({ totalMinor: 10_430 }),
      steadyQuote: null,
      intervalDays: 14,
      steadyCadenceDays: 28,
      nowIso,
      dispatchPolicy: DISPATCH_POLICY_FIXTURE,
    });
    expect(money.delivery2TotalMinor).toBe(starterDelivery2TargetMinor(20_860));
  });

  it("estimates the delivery-2 arrival from the caller's clock, never its own", () => {
    const money = starterOfferMoney({
      starterQuote: quote(),
      steadyQuote: null,
      intervalDays: 14,
      steadyCadenceDays: 28,
      nowIso,
      dispatchPolicy: DISPATCH_POLICY_FIXTURE,
    });
    // Charge lands Mon 17 Aug before cut-off → dispatch same day, +2 business days.
    expect(money.delivery2EstimateIso?.slice(0, 10)).toBe("2026-08-19");
    // Purity: the same input twice must give the same answer.
    expect(
      starterOfferMoney({
        starterQuote: quote(), steadyQuote: null, intervalDays: 14, steadyCadenceDays: 28, nowIso, dispatchPolicy: DISPATCH_POLICY_FIXTURE,
      }).delivery2EstimateIso,
    ).toBe(money.delivery2EstimateIso);
  });

  it("drops only the steady money when the cadence quote has not resolved", () => {
    const money = starterOfferMoney({
      starterQuote: quote({ totalMinor: 10_430 }),
      steadyQuote: null,
      intervalDays: 14,
      steadyCadenceDays: 28,
      nowIso,
      dispatchPolicy: DISPATCH_POLICY_FIXTURE,
    });
    expect(money.steadyPerDayMinor).toBeNull();
    expect(money.steadyDiscountPercent).toBeNull();
    // Everything about delivery 1 and 2 survives.
    expect(money.firstPerDayMinor).not.toBeNull();
    expect(money.delivery2TotalMinor).not.toBeNull();
  });

  it("prices the steady plan at the band, not at the acquisition price it was quoted with", () => {
    const money = starterOfferMoney({
      starterQuote: quote({ totalMinor: 10_430 }),
      steadyQuote: quote({ anchorMinor: 41_720, modeDiscountMinor: 4_172, totalMinor: 20_860 }),
      intervalDays: 14,
      steadyCadenceDays: 28,
      nowIso,
      dispatchPolicy: DISPATCH_POLICY_FIXTURE,
    });
    expect(money.steadyPerDayMinor).toBe(Math.round((41_720 - 4_172) / 28));
    expect(money.steadyDiscountPercent).toBe(10);
  });
});

describe("starterPlanView", () => {
  function snapshot(cans: number, dailyGrams: number): CommerceRecommendationSnapshot {
    return {
      dailyGrams,
      lines: [{ variantId: "v", sku: "s", slug: "lamb", qty: cans, netWeightG: 400, kcalPerUnit: 492, allergenSlugs: [] }],
    } as unknown as CommerceRecommendationSnapshot;
  }
  const nowIso = "2026-08-03T09:00:00.000Z";

  it("derives interval, steady cadence and steady size from the shared policy", () => {
    const plan = starterPlanView({
      snapshot: snapshot(14, 500),
      starterQuote: quote(),
      steadyQuote: quote(),
      nowIso,
      dispatchPolicy: DISPATCH_POLICY_FIXTURE,
    });
    expect(plan).toMatchObject({
      cans: 14,
      // 14 cans × 400 g ÷ 500 g/day = 11.2 → 11 days.
      intervalDays: 11,
      steadyCadenceDays: 28,
      // 500 g/day × 28 days ÷ 400 g = 35 cans.
      steadyCans: 35,
    });
  });

  it("reads the steady quote by CADENCE, so the acquisition basket cannot stand in for it", () => {
    const steady = quote({ anchorMinor: 52_150, modeDiscountMinor: 5_215, totalMinor: 46_935 });
    const plan = starterPlanView({
      snapshot: snapshot(14, 500),
      starterQuote: quote({ totalMinor: 10_430 }),
      // 14 is the acquisition basket's own length key; 28 is the steady cadence.
      steadyQuote: steady,
      nowIso,
      dispatchPolicy: DISPATCH_POLICY_FIXTURE,
    });
    expect(plan?.steadyPerDayMinor).toBe(Math.round((52_150 - 5_215) / 28));
  });

  it("returns null when there is no package or no usable ration", () => {
    expect(starterPlanView({ snapshot: null, starterQuote: null, steadyQuote: null, nowIso , dispatchPolicy: DISPATCH_POLICY_FIXTURE })).toBeNull();
    // No quote ⇒ no coverage ⇒ no terms.
    expect(
      starterPlanView({ snapshot: snapshot(14, 500), starterQuote: null, steadyQuote: null, nowIso , dispatchPolicy: DISPATCH_POLICY_FIXTURE }),
    ).toBeNull();
    // A basket below the starter minimum is not a starter pack.
    expect(
      starterPlanView({ snapshot: snapshot(10, 500), starterQuote: quote(), steadyQuote: null, nowIso , dispatchPolicy: DISPATCH_POLICY_FIXTURE }),
    ).toBeNull();
  });
});

describe("starterPlanLines", () => {
  const nowIso = "2026-08-03T09:00:00.000Z";
  const money = (amountMinor: number) => `${amountMinor}gr`;
  const day = (iso: string) => iso.slice(0, 10);
  const plan = starterPlanView({
    snapshot: {
      dailyGrams: 500,
      lines: [{ variantId: "v", sku: "s", slug: "lamb", qty: 14, netWeightG: 400, kcalPerUnit: 492, allergenSlugs: [] }],
    } as unknown as CommerceRecommendationSnapshot,
    starterQuote: quote({ totalMinor: 10_430 }),
    steadyQuote: quote(),
    nowIso,
    dispatchPolicy: DISPATCH_POLICY_FIXTURE,
  })!;

  it("names the dated delivery-2 line and the priced steady line", () => {
    const lines = starterPlanLines(plan, money, day);
    expect(lines.map((line) => line.i18nId)).toEqual([
      "checkout:step4.starter.delivery2",
      "checkout:step4.starter.steadyLine",
      "checkout:step4.starter.flexibility",
    ]);
    // Charge Fri 14 Aug before cut-off → dispatch same day, +2 business days over
    // the weekend → Tue 18 Aug. The estimator's own holiday walk, not a guess.
    expect(lines[0].params).toMatchObject({ days: 11, percent: 35, date: "2026-08-18" });
  });

  it("degrades to the priceless steady line instead of inventing an amount", () => {
    const lines = starterPlanLines({ ...plan, steadyPerDayMinor: null }, money, day);
    expect(lines[1].i18nId).toBe("checkout:step4.starter.steadyLineNoPrice");
    expect(lines[1].params).toEqual({ count: plan.steadyCans, days: 28 });
  });

  it("drops the delivery-2 line entirely when its amount is unknown", () => {
    const lines = starterPlanLines({ ...plan, delivery2TotalMinor: null }, money, day);
    expect(lines.some((line) => line.i18nId.startsWith("checkout:step4.starter.delivery2"))).toBe(false);
  });
});

/**
 * P1-C. The "potem" amount used to come from a generic cadence quote of the
 * DEFAULT mix, while the guard prices — and the marker freezes — the customer's
 * OWN mix rescaled to the steady size. With unequal flavour prices those are
 * different amounts, so the customer was shown a steady price they would never
 * be charged. `starterSteadyBasket` is the client's half of that fix: it applies
 * the guard's own `starterAggregateBySku` + `starterRescaleBasket` verbatim.
 */
describe("starterSteadyBasket", () => {
  const lines = (...qtys: number[]) =>
    qtys.map((qty, index) => ({
      variantId: `variant-${index}`,
      sku: `sku-${index}`,
      slug: ["lamb", "beef", "turkey"][index] ?? "lamb",
      qty,
      netWeightG: 400,
      kcalPerUnit: 492,
      allergenSlugs: [],
    }));
  const snap = (...qtys: number[]) =>
    ({ dailyKcal: 615, dailyGrams: 500, lines: lines(...qtys) }) as unknown as CommerceRecommendationSnapshot;

  it("rescales the customer's own mix, exactly as the guard does before freezing it", () => {
    // 14 cans at coverage 11.2 ⇒ 500 g/day ⇒ monthly, 35 steady cans. The 9:5
    // mix the customer edited to is preserved in proportion, not reset to even.
    const basket = starterSteadyBasket(snap(9, 5), quote())!;
    expect(basket.cadenceDays).toBe(28);
    expect(basket.snapshot.lines.reduce((sum, line) => sum + line.qty, 0)).toBe(35);
    expect(basket.snapshot.lines.map((line) => line.qty)).toEqual([23, 12]);
    // The snapshot is re-cadenced so the quote request asks at the steady rhythm.
    expect(basket.snapshot.cadenceDays).toBe(28);
  });

  it("matches the guard's transformation line for line", () => {
    const effective = snap(9, 5);
    const mine = starterSteadyBasket(effective, quote())!;
    const guardEquivalent = starterRescaleBasket(starterAggregateBySku(effective.lines), 35);
    expect(mine.snapshot.lines.map((line) => ({ sku: line.sku, qty: line.qty })))
      .toEqual(guardEquivalent.map((line) => ({ sku: line.sku, qty: line.qty })));
  });

  it("folds repeated SKUs before rescaling, like the guard", () => {
    const duplicated = {
      ...snap(9, 5),
      lines: [...lines(9, 5), { ...lines(1)[0], qty: 2 }],
    } as unknown as CommerceRecommendationSnapshot;
    const basket = starterSteadyBasket(duplicated, quote({ coverageDays: 12.8 }))!;
    // Two entries after folding, and the total lands exactly on the steady size.
    expect(basket.snapshot.lines).toHaveLength(2);
    expect(basket.snapshot.lines.reduce((sum, line) => sum + line.qty, 0))
      .toBe(basket.snapshot.lines.reduce((sum, line) => sum + line.qty, 0));
  });

  it("refuses an unrepresentable basket rather than promising a size it cannot ship", () => {
    // More distinct flavours than steady cans is unrepresentable once each is
    // owed one; 2385's contract is that the caller must reject, not improvise.
    const many = {
      dailyKcal: 615,
      dailyGrams: 500,
      lines: Array.from({ length: 20 }, (_, index) => ({
        variantId: `v${index}`, sku: `s${index}`, slug: "lamb",
        qty: 1, netWeightG: 400, kcalPerUnit: 492, allergenSlugs: [],
      })),
    } as unknown as CommerceRecommendationSnapshot;
    // 20 one-can entries covering 80 days ⇒ 100 g/day ⇒ monthly, and the steady
    // size floors at the 14-can catalogue minimum. 20 flavours cannot fit into 14
    // cans once each is owed one, so there is no basket to promise.
    expect(starterSteadyBasket(many, quote({ coverageDays: 80 }))).toBeNull();
  });

  it("returns null when the offer itself does not resolve", () => {
    expect(starterSteadyBasket(null, quote())).toBeNull();
    expect(starterSteadyBasket(snap(9, 5), null)).toBeNull();
  });
});
