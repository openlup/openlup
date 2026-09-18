/**
 * Starter-pack acquisition offer: the pure policy layer.
 *
 * One offer, one shape. A first-order-eligible customer buys N >= 14 cans of
 * 400 g at -50% (delivery 1, through the existing `first_subscription_50`
 * promotion — untouched here). Delivery 2 is the SAME template at -35% off the
 * catalog list anchor, charged `I` days after the delivery-1 payment. Delivery
 * 3 onwards is the steady plan at the band prices frozen at checkout.
 *
 * Everything in this module is a pure function of numbers. It holds no clock,
 * no client, and no I/O, so the configurator (wave 3), the eligibility handler
 * and the checkout guard can all agree on the same arithmetic without any of
 * them being able to disagree with the others.
 *
 * ⛔ These constants are the contract. The server recomputes every one of them
 * from its own inputs at checkout and rejects a mismatch; a client that sends a
 * different interval or rate does not get a different price, it gets a
 * rejection.
 */

/** Capability token the client sends to opt into the starter-offer lane. */
export const STARTER_OFFER_CAPABILITY = "commerce.starter_offer.v1" as const;

/** Delivery 1: -50%, served by the existing `first_subscription_50` promotion. */
export const STARTER_INITIAL_DISCOUNT_BPS = 5_000;

/** Delivery 2: -35% off the catalog LIST anchor (not off the band subtotal). */
export const STARTER_DELIVERY2_DISCOUNT_BPS = 3_500;

/** Renewal cadence bounds the acquisition interval is clamped into. */
export const STARTER_INTERVAL_MIN_DAYS = 7;
export const STARTER_INTERVAL_MAX_DAYS = 28;

/** At or above this daily ration the steady plan runs fortnightly, else monthly. */
export const STARTER_STEADY_CADENCE_THRESHOLD_G_PER_DAY = 800;

/**
 * Ration cap used for cadence and interval arithmetic only. A 90 kg dog eating
 * 2 kg/day would otherwise compute a 3-day interval, which no logistics lane
 * serves; the cap makes the biggest dogs land on the shortest supported cycle
 * instead of an impossible one.
 */
export const STARTER_MAX_DAILY_GRAMS = 1_500;

/** Net weight of one can. The offer is defined in cans, the ration in grams. */
export const STARTER_CAN_NET_WEIGHT_G = 400;

/** Minimum cans that make a basket a starter pack. */
export const STARTER_MIN_CANS = 14;

/**
 * A discounted delivery must still be chargeable. 1 PLN (100 gr) is the floor
 * the promotion engine already uses for its own product lane, so a starter
 * discount can never produce an order the payment provider refuses.
 */
export const STARTER_MIN_PAYABLE_MINOR = 100;

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The ration every downstream computation actually uses: the dog's daily grams,
 * capped. Returns `null` for a missing, non-finite or non-positive ration so a
 * caller cannot accidentally treat "unknown" as zero.
 */
export function starterEffectiveDailyGrams(
  dailyGrams: number | null | undefined,
): number | null {
  if (!isPositiveFinite(dailyGrams)) return null;
  return Math.min(dailyGrams, STARTER_MAX_DAILY_GRAMS);
}

/**
 * Days between the delivery-1 payment and the delivery-2 charge:
 * `clamp(round(cans * 400 / effectiveDailyGrams), 7, 28)`.
 *
 * `null` when the ration is unusable or the basket is under the 14-can minimum
 * the offer is defined for — there is no starter interval for a basket that is
 * not a starter pack.
 */
export function starterIntervalDays(
  cans: number | null | undefined,
  dailyGrams: number | null | undefined,
): number | null {
  const effective = starterEffectiveDailyGrams(dailyGrams);
  if (effective === null) return null;
  if (typeof cans !== "number" || !Number.isInteger(cans) || cans < STARTER_MIN_CANS) return null;
  const raw = Math.round((cans * STARTER_CAN_NET_WEIGHT_G) / effective);
  return Math.min(Math.max(raw, STARTER_INTERVAL_MIN_DAYS), STARTER_INTERVAL_MAX_DAYS);
}

/**
 * Steady cadence from delivery 3 on: fortnightly for a big eater, monthly
 * otherwise. `null` when the ration is unusable.
 */
export function starterSteadyCadenceDays(
  dailyGrams: number | null | undefined,
): 14 | 28 | null {
  const effective = starterEffectiveDailyGrams(dailyGrams);
  if (effective === null) return null;
  return effective >= STARTER_STEADY_CADENCE_THRESHOLD_G_PER_DAY ? 14 : 28;
}

/**
 * Cans one steady cadence needs, never below the catalogue minimum.
 *
 * The single definition of the graduation basket size: what the customer is told
 * they will get from delivery 3 on, what the client asks for, and what the server
 * freezes into the marker are one arithmetic, not three that happen to agree.
 * Takes the ALREADY-capped ration (see {@link starterEffectiveDailyGrams}).
 */
export function starterSteadyCans(effectiveDailyGrams: number, cadenceDays: number): number {
  const raw = Math.round((effectiveDailyGrams * cadenceDays) / STARTER_CAN_NET_WEIGHT_G);
  return Math.max(raw, STARTER_MIN_CANS);
}

/** Every term of the offer, derived together from one measurement. */
export interface StarterTerms {
  dailyGrams: number;
  effectiveDailyGrams: number;
  intervalDays: number;
  cadenceDays: 14 | 28;
  steadyCans: number;
}

/**
 * The ration, from the SERVER's own measurement of the basket it priced:
 * `cans * 400 / feedingCoverageDays`.
 *
 * ⛔ The only admissible input. A recommendation snapshot's `dailyGrams` looks
 * equivalent and is not: it is an integer rounded from the CLIENT's energy
 * table, while coverage is recomputed by the server from the trusted catalogue.
 * They disagree by a fraction often enough to move `round()` across a day
 * boundary — and since a rejected checkout re-quotes without changing either
 * operand, that is not a transient, it is an infinite
 * `starter_offer_terms_drifted` loop.
 */
export function starterDailyGramsFromCoverage(cans: number, coverageDays: number | null | undefined): number | null {
  if (!isPositiveFinite(coverageDays)) return null;
  if (!isPositiveFinite(cans)) return null;
  return (cans * STARTER_CAN_NET_WEIGHT_G) / coverageDays;
}

/**
 * The complete offer, from a basket size and the coverage the server measured for
 * it. `null` when the ration is unusable or the basket is not a starter pack.
 *
 * The guard, the checkout intent and the price on screen all call THIS — not
 * three mirrored copies — so terms drift stops being something that can happen
 * between them.
 */
export function starterTermsFromCoverage(cans: number, coverageDays: number | null | undefined): StarterTerms | null {
  const dailyGrams = starterDailyGramsFromCoverage(cans, coverageDays);
  const effectiveDailyGrams = starterEffectiveDailyGrams(dailyGrams);
  const intervalDays = starterIntervalDays(cans, dailyGrams);
  const cadenceDays = starterSteadyCadenceDays(dailyGrams);
  if (
    dailyGrams === null ||
    effectiveDailyGrams === null ||
    intervalDays === null ||
    cadenceDays === null
  ) {
    return null;
  }
  return {
    dailyGrams,
    effectiveDailyGrams,
    intervalDays,
    cadenceDays,
    steadyCans: starterSteadyCans(effectiveDailyGrams, cadenceDays),
  };
}

/**
 * BigInt ceil of `value * multiplier / 10_000`.
 *
 * Parity note: byte-for-byte the same arithmetic as the private
 * `multiplyDivideCeil` in the `@openlup/core` promo adjustment engine and in
 * `server/domains/commerce/adminPromotionSemantic.ts`. Neither exports it, and
 * this module must stay importable from the browser bundle, so it is
 * reimplemented rather than re-exported. `starterOfferPolicy.test.ts` pins the
 * equality against a hand-computed table; if the promo engine ever changes its
 * rounding, that table is the thing that has to move first.
 */
function multiplyDivideCeil(value: number, multiplier: number): number {
  const product = BigInt(value) * BigInt(multiplier);
  return Number((product + 9_999n) / 10_000n);
}

/**
 * What delivery 2 must cost: 65% of the catalog LIST anchor, rounded up.
 *
 * The anchor is the undiscounted list total of the same lines, NOT the
 * subscription band subtotal — "-35% off list" is the promise made to the
 * customer, and the band already carries its own smaller discount.
 */
export function starterDelivery2TargetMinor(listAnchorTotalMinor: number): number {
  if (!Number.isFinite(listAnchorTotalMinor) || listAnchorTotalMinor <= 0) return 0;
  return multiplyDivideCeil(
    Math.trunc(listAnchorTotalMinor),
    10_000 - STARTER_DELIVERY2_DISCOUNT_BPS,
  );
}

/**
 * The delivery-2 discount to freeze into the marker: the gap between the band
 * subtotal the renewal would otherwise charge and the -35%-off-list target.
 *
 * Never negative — when the band price is already at or below the target, the
 * customer keeps the band price and the discount is zero. `null` when applying
 * it would leave less than `STARTER_MIN_PAYABLE_MINOR` payable, which is the
 * signal to refuse the offer rather than mint an uncollectable renewal.
 */
export function starterDelivery2DiscountMinor(input: {
  bandSubtotalMinor: number;
  listAnchorTotalMinor: number;
}): number | null {
  const { bandSubtotalMinor, listAnchorTotalMinor } = input;
  if (!Number.isFinite(bandSubtotalMinor) || bandSubtotalMinor < 0) return null;
  const target = starterDelivery2TargetMinor(listAnchorTotalMinor);
  const discount = Math.max(0, Math.trunc(bandSubtotalMinor) - target);
  const payable = Math.trunc(bandSubtotalMinor) - discount;
  if (payable < STARTER_MIN_PAYABLE_MINOR) return null;
  return discount;
}

/** Minimal shape the basket helpers below need: a SKU and a can count. */
export interface StarterBasketEntry {
  sku: string;
  qty: number;
}

/**
 * Folds repeated SKUs into one entry BEFORE rescaling.
 *
 * A checkout intent admits up to 50 line entries with no uniqueness constraint,
 * and `starterRescaleBasket` floors every ENTRY at one can, so 29 one-can
 * entries of the SAME sku cannot shrink to a 28-can steady basket. Folded first,
 * they are a single 29-can entry that rescales exactly.
 */
export function starterAggregateBySku<T extends StarterBasketEntry>(entries: readonly T[]): T[] {
  const bySku = new Map<string, T>();
  for (const entry of entries) {
    const existing = bySku.get(entry.sku);
    if (existing) existing.qty += entry.qty;
    else bySku.set(entry.sku, { ...entry });
  }
  return [...bySku.values()];
}

/**
 * Rescales a flavour mix to `targetCans` by largest remainder, so the customer's
 * own proportions survive and every selected flavour keeps at least one can — a
 * graduation that silently drops a recipe changes what the dog eats.
 *
 * ⚠️ The result is NOT guaranteed to total `targetCans`: more DISTINCT flavours
 * than cans is unrepresentable once each is owed one. Callers MUST check the sum
 * and treat a mismatch as a rejection, never as a plan.
 */
export function starterRescaleBasket<T extends StarterBasketEntry>(
  entries: readonly T[],
  targetCans: number,
): T[] {
  const currentTotal = entries.reduce((total, entry) => total + entry.qty, 0);
  if (currentTotal <= 0) return [...entries];
  const scaled = entries.map((entry) => {
    const exact = (entry.qty * targetCans) / currentTotal;
    return { entry, qty: Math.max(1, Math.floor(exact)), remainder: exact - Math.floor(exact) };
  });
  let diff = targetCans - scaled.reduce((total, row) => total + row.qty, 0);
  const byRemainder = [...scaled].sort((left, right) => right.remainder - left.remainder);
  while (diff > 0) {
    for (const row of byRemainder) {
      if (diff <= 0) break;
      row.qty += 1;
      diff -= 1;
    }
  }
  // Over-allocation (every flavour forced to at least one can on a small basket)
  // is trimmed from the largest lines. It can stall when nothing is trimmable —
  // that is the unrepresentable case the caller has to reject.
  while (diff < 0) {
    const trimmable = scaled.filter((row) => row.qty > 1).sort((l, r) => r.qty - l.qty);
    if (trimmable.length === 0) break;
    for (const row of trimmable) {
      if (diff >= 0) break;
      row.qty -= 1;
      diff += 1;
    }
  }
  return scaled.map((row) => ({ ...row.entry, qty: row.qty }));
}
