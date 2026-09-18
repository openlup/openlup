import { describe, expect, it } from "vitest";
import {
  STARTER_CAN_NET_WEIGHT_G,
  STARTER_DELIVERY2_DISCOUNT_BPS,
  STARTER_INITIAL_DISCOUNT_BPS,
  STARTER_INTERVAL_MAX_DAYS,
  STARTER_INTERVAL_MIN_DAYS,
  STARTER_MAX_DAILY_GRAMS,
  STARTER_MIN_CANS,
  STARTER_MIN_PAYABLE_MINOR,
  STARTER_OFFER_CAPABILITY,
  STARTER_STEADY_CADENCE_THRESHOLD_G_PER_DAY,
  starterDelivery2DiscountMinor,
  starterDelivery2TargetMinor,
  starterAggregateBySku,
  starterEffectiveDailyGrams,
  starterIntervalDays,
  starterRescaleBasket,
  starterSteadyCadenceDays,
} from "./starterOfferPolicy.js";

describe("starter offer policy constants", () => {
  it("pins the wire-visible constants", () => {
    expect(STARTER_OFFER_CAPABILITY).toBe("commerce.starter_offer.v1");
    expect(STARTER_INITIAL_DISCOUNT_BPS).toBe(5_000);
    expect(STARTER_DELIVERY2_DISCOUNT_BPS).toBe(3_500);
    expect(STARTER_INTERVAL_MIN_DAYS).toBe(7);
    expect(STARTER_INTERVAL_MAX_DAYS).toBe(28);
    expect(STARTER_STEADY_CADENCE_THRESHOLD_G_PER_DAY).toBe(800);
    expect(STARTER_MAX_DAILY_GRAMS).toBe(1_500);
    expect(STARTER_CAN_NET_WEIGHT_G).toBe(400);
    expect(STARTER_MIN_CANS).toBe(14);
    expect(STARTER_MIN_PAYABLE_MINOR).toBe(100);
  });
});

/**
 * The ten-dog stress table the offer was designed against. `P` is the raw daily
 * ration in grams; every dog buys the 14-can minimum. This is the single table
 * the configurator (wave 3), the eligibility response and the checkout guard all
 * have to agree with, so it is spelled out literally rather than computed.
 */
const STRESS_TABLE: Array<{ dailyGrams: number; intervalDays: number; cadenceDays: 14 | 28 }> = [
  { dailyGrams: 100, intervalDays: 28, cadenceDays: 28 },
  { dailyGrams: 200, intervalDays: 28, cadenceDays: 28 },
  { dailyGrams: 300, intervalDays: 19, cadenceDays: 28 },
  { dailyGrams: 400, intervalDays: 14, cadenceDays: 28 },
  { dailyGrams: 500, intervalDays: 11, cadenceDays: 28 },
  { dailyGrams: 600, intervalDays: 9, cadenceDays: 28 },
  { dailyGrams: 700, intervalDays: 8, cadenceDays: 28 },
  { dailyGrams: 800, intervalDays: 7, cadenceDays: 14 },
  { dailyGrams: 1_000, intervalDays: 7, cadenceDays: 14 },
  // Above the cap: behaves exactly as 1500 g/day, not as 1700.
  { dailyGrams: 1_700, intervalDays: 7, cadenceDays: 14 },
];

describe("starterIntervalDays / starterSteadyCadenceDays", () => {
  it.each(STRESS_TABLE)(
    "P=$dailyGrams g/day with 14 cans -> I=$intervalDays, C=$cadenceDays",
    ({ dailyGrams, intervalDays, cadenceDays }) => {
      expect(starterIntervalDays(14, dailyGrams)).toBe(intervalDays);
      expect(starterSteadyCadenceDays(dailyGrams)).toBe(cadenceDays);
    },
  );

  it("splits the stress table 7 monthly / 3 fortnightly", () => {
    const cadences = STRESS_TABLE.map((row) => starterSteadyCadenceDays(row.dailyGrams));
    expect(cadences.filter((c) => c === 28)).toHaveLength(7);
    expect(cadences.filter((c) => c === 14)).toHaveLength(3);
  });

  it("rounds half up: 14 cans at 448 g/day is 12.5 days -> 13", () => {
    expect((14 * STARTER_CAN_NET_WEIGHT_G) / 448).toBe(12.5);
    expect(starterIntervalDays(14, 448)).toBe(13);
  });

  it("clamps below 7 and above 28", () => {
    // 14 cans at 1200 g/day is 4.67 days -> clamped up to 7.
    expect(starterIntervalDays(14, 1_200)).toBe(7);
    // 14 cans at 50 g/day is 112 days -> clamped down to 28.
    expect(starterIntervalDays(14, 50)).toBe(28);
  });

  it("treats the ration cap boundary 1500 / 1501 identically", () => {
    expect(starterEffectiveDailyGrams(1_500)).toBe(1_500);
    expect(starterEffectiveDailyGrams(1_501)).toBe(1_500);
    expect(starterIntervalDays(14, 1_500)).toBe(starterIntervalDays(14, 1_501));
    expect(starterSteadyCadenceDays(1_500)).toBe(starterSteadyCadenceDays(1_501));
  });

  it("puts the cadence threshold boundary on the fortnightly side at exactly 800", () => {
    expect(starterSteadyCadenceDays(799)).toBe(28);
    expect(starterSteadyCadenceDays(800)).toBe(14);
  });

  it("returns null for an unusable ration", () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(starterEffectiveDailyGrams(bad)).toBeNull();
      expect(starterIntervalDays(14, bad)).toBeNull();
      expect(starterSteadyCadenceDays(bad)).toBeNull();
    }
  });

  it("returns null below the 14-can minimum or for a non-integer basket", () => {
    expect(starterIntervalDays(13, 400)).toBeNull();
    expect(starterIntervalDays(14, 400)).toBe(14);
    expect(starterIntervalDays(14.5, 400)).toBeNull();
    expect(starterIntervalDays(Number.NaN, 400)).toBeNull();
  });
});

describe("starterDelivery2TargetMinor", () => {
  /**
   * Hand-computed `ceil(list * 6500 / 10000)`. This table is the parity pin for
   * the local BigInt reimplementation of the promo engine's `multiplyDivideCeil`
   * — if the promo engine ever changes its rounding, this table moves first.
   */
  const TARGETS: Array<[list: number, target: number]> = [
    [0, 0],
    [1, 1], // 0.65 -> 1
    [2, 2], // 1.30 -> 2
    [3, 2], // 1.95 -> 2
    [100, 65],
    [101, 66], // 65.65 -> 66
    [999, 650], // 649.35 -> 650
    [1_000, 650], // exact, no rounding up
    [12_345, 8_025], // 8024.25 -> 8025
    [19_998, 12_999], // 12998.7 -> 12999
    [20_000, 13_000],
    [999_999_999, 650_000_000], // 649999999.35 -> 650000000
  ];

  it.each(TARGETS)("list %i -> target %i", (list, target) => {
    expect(starterDelivery2TargetMinor(list)).toBe(target);
  });

  it("never rounds down (the customer never pays less than -35% off list)", () => {
    for (let list = 0; list <= 400; list += 1) {
      expect(starterDelivery2TargetMinor(list)).toBe(Math.ceil((list * 6_500) / 10_000));
    }
  });

  it("is zero for a missing or non-positive anchor", () => {
    expect(starterDelivery2TargetMinor(0)).toBe(0);
    expect(starterDelivery2TargetMinor(-1)).toBe(0);
    expect(starterDelivery2TargetMinor(Number.NaN)).toBe(0);
  });
});

describe("starterDelivery2DiscountMinor", () => {
  it("closes the gap between the band subtotal and the -35%-off-list target", () => {
    // List 20000, target 13000. Band already 16000 -> discount 3000.
    expect(
      starterDelivery2DiscountMinor({ bandSubtotalMinor: 16_000, listAnchorTotalMinor: 20_000 }),
    ).toBe(3_000);
  });

  it("is zero when the band price is already at or below the target", () => {
    expect(
      starterDelivery2DiscountMinor({ bandSubtotalMinor: 13_000, listAnchorTotalMinor: 20_000 }),
    ).toBe(0);
    expect(
      starterDelivery2DiscountMinor({ bandSubtotalMinor: 12_000, listAnchorTotalMinor: 20_000 }),
    ).toBe(0);
  });

  it("leaves exactly the target payable", () => {
    const discount = starterDelivery2DiscountMinor({
      bandSubtotalMinor: 18_500,
      listAnchorTotalMinor: 20_000,
    });
    expect(discount).not.toBeNull();
    expect(18_500 - (discount ?? 0)).toBe(starterDelivery2TargetMinor(20_000));
  });

  it("refuses (null) when less than 100 minor would stay payable", () => {
    // Target 65 < the 100 floor.
    expect(
      starterDelivery2DiscountMinor({ bandSubtotalMinor: 5_000, listAnchorTotalMinor: 100 }),
    ).toBeNull();
    // Band itself under the floor: nothing to discount, still uncollectable.
    expect(
      starterDelivery2DiscountMinor({ bandSubtotalMinor: 99, listAnchorTotalMinor: 1_000_000 }),
    ).toBeNull();
    // Exactly at the floor is admitted.
    expect(
      starterDelivery2DiscountMinor({ bandSubtotalMinor: 100, listAnchorTotalMinor: 1_000_000 }),
    ).toBe(0);
  });

  it("refuses a negative or non-finite band subtotal", () => {
    expect(
      starterDelivery2DiscountMinor({ bandSubtotalMinor: -1, listAnchorTotalMinor: 20_000 }),
    ).toBeNull();
    expect(
      starterDelivery2DiscountMinor({ bandSubtotalMinor: Number.NaN, listAnchorTotalMinor: 20_000 }),
    ).toBeNull();
  });
});

describe("starterAggregateBySku / starterRescaleBasket", () => {
  const entries = (specs: Array<[sku: string, qty: number]>) =>
    specs.map(([sku, qty]) => ({ sku, qty }));

  it("folds repeated skus and keeps the first entry's other fields", () => {
    expect(
      starterAggregateBySku([
        { sku: "a", qty: 10, variantId: "v-a" },
        { sku: "b", qty: 4, variantId: "v-b" },
        { sku: "a", qty: 5, variantId: "v-a-again" },
      ]),
    ).toEqual([
      { sku: "a", qty: 15, variantId: "v-a" },
      { sku: "b", qty: 4, variantId: "v-b" },
    ]);
  });

  it("does not mutate the caller's entries", () => {
    const input = entries([["a", 10], ["a", 5]]);
    starterAggregateBySku(input);
    expect(input).toEqual([{ sku: "a", qty: 10 }, { sku: "a", qty: 5 }]);
  });

  it("keeps the customer's proportions and lands exactly on the target", () => {
    const scaled = starterRescaleBasket(entries([["a", 7], ["b", 4], ["c", 3]]), 28);
    expect(scaled.map((entry) => entry.qty)).toEqual([14, 8, 6]);
    expect(scaled.reduce((total, entry) => total + entry.qty, 0)).toBe(28);
  });

  it("gives every flavour at least one can", () => {
    const scaled = starterRescaleBasket(entries([["a", 100], ["b", 1]]), 14);
    expect(scaled.every((entry) => entry.qty >= 1)).toBe(true);
    expect(scaled.reduce((total, entry) => total + entry.qty, 0)).toBe(14);
  });

  /**
   * The raw shape of P1-2, kept as an executable statement of WHY the guard has
   * to aggregate first and check the sum after: more distinct entries than
   * target cans is unrepresentable, and this function reports it by returning a
   * basket that does NOT total the target rather than by throwing.
   */
  it("cannot shrink 29 one-can entries to 28 and says so by missing the target", () => {
    const scaled = starterRescaleBasket(
      Array.from({ length: 29 }, (_unused, index) => ({ sku: `sku-${index}`, qty: 1 })),
      28,
    );
    expect(scaled.reduce((total, entry) => total + entry.qty, 0)).toBe(29);
  });

  it("but aggregating first makes the duplicate-sku version representable", () => {
    const duplicates = Array.from({ length: 29 }, () => ({ sku: "same", qty: 1 }));
    const scaled = starterRescaleBasket(starterAggregateBySku(duplicates), 28);
    expect(scaled).toEqual([{ sku: "same", qty: 28 }]);
  });

  it("returns the entries unchanged for an empty basket", () => {
    expect(starterRescaleBasket(entries([["a", 0]]), 28)).toEqual([{ sku: "a", qty: 0 }]);
  });
});
