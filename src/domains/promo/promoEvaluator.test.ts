import { describe, expect, it } from "vitest";
import { evaluatePromos, promoEligibilityFailure } from "./promoEvaluator.js";
import type { PromoEvaluationCart, PromotionRow } from "./types.js";

const NOW = "2026-06-03T14:00:00Z";

function makeCart(overrides: Partial<PromoEvaluationCart> = {}): PromoEvaluationCart {
  return {
    region_code: "PL",
    cart_mode: "one_time",
    cart_subtotal_minor: 20860,
    shipping_amount_minor: 990,
    client_orders_count: 0,
    applied_codes: [],
    ...overrides,
  };
}

function makePromo(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: "promo-base",
    code: null,
    name: "Base",
    trigger_type: "automatic",
    discount_type: "percentage",
    discount_value: 10,
    applies_to_kind: "order_total",
    applies_to_payload: {},
    stacking_rule: "exclusive",
    eligibility: {},
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
    status: "active",
    region_availability: ["PL"],
    ...overrides,
  };
}

describe("evaluatePromos — basic flow", () => {
  it("applies an automatic percentage promo on a first-purchase cart", () => {
    const applied = evaluatePromos({
      cart: makeCart({ client_orders_count: 0 }),
      candidates: [
        makePromo({
          id: "first-10",
          name: "First Purchase 10%",
          eligibility: { first_purchase: true },
        }),
      ],
      now: NOW,
    });

    expect(applied).toHaveLength(1);
    expect(applied[0].amount_off_minor).toBe(Math.floor(20860 * 10 / 100));
    expect(applied[0].reason_code).toBe("promo:first_purchase_10");
  });

  it("rejects a first-purchase promo for a returning customer", () => {
    const applied = evaluatePromos({
      cart: makeCart({ client_orders_count: 3 }),
      candidates: [
        makePromo({ id: "first-10", eligibility: { first_purchase: true } }),
      ],
      now: NOW,
    });

    expect(applied).toEqual([]);
  });

  it("applies a coupon promotion only when the code is present in the cart", () => {
    const promo = makePromo({
      id: "welcome",
      code: "WELCOME10",
      trigger_type: "coupon_code",
      name: "Welcome 10%",
    });

    const without = evaluatePromos({
      cart: makeCart({ applied_codes: [] }),
      candidates: [promo],
      now: NOW,
    });
    expect(without).toEqual([]);

    const withCode = evaluatePromos({
      cart: makeCart({ applied_codes: ["WELCOME10"] }),
      candidates: [promo],
      now: NOW,
    });
    expect(withCode).toHaveLength(1);
    expect(withCode[0].reason_code).toBe("promo:WELCOME10");
  });

  it("matches a free_shipping promo for subscription carts only", () => {
    const promo = makePromo({
      id: "sub-free-ship",
      name: "Subscription Free Shipping",
      discount_type: "free_shipping",
      stacking_rule: "stackable_with_any",
      applies_to_payload: { cart_mode: "subscription" },
    });

    const oneTime = evaluatePromos({
      cart: makeCart({ cart_mode: "one_time", shipping_amount_minor: 990 }),
      candidates: [promo],
      now: NOW,
    });
    expect(oneTime).toEqual([]);

    const subscription = evaluatePromos({
      cart: makeCart({ cart_mode: "subscription", shipping_amount_minor: 990 }),
      candidates: [promo],
      now: NOW,
    });
    expect(subscription).toHaveLength(1);
    expect(subscription[0].amount_off_minor).toBe(990);
    expect(subscription[0].discount_type).toBe("free_shipping");
  });
});

describe("evaluatePromos — region / window / status gating", () => {
  it("ignores promos outside the cart region", () => {
    const applied = evaluatePromos({
      cart: makeCart({ region_code: "PL" }),
      candidates: [makePromo({ region_availability: ["EU"] })],
      now: NOW,
    });
    expect(applied).toEqual([]);
  });

  it("ignores promos outside the valid_from/valid_to window", () => {
    const expired = makePromo({
      valid_from: "2026-01-01T00:00:00Z",
      valid_to: "2026-05-01T00:00:00Z",
    });
    const applied = evaluatePromos({
      cart: makeCart(),
      candidates: [expired],
      now: NOW,
    });
    expect(applied).toEqual([]);
  });

  it("ignores draft / paused / archived promos", () => {
    const candidates = ["draft", "paused", "archived"].map((status, i) =>
      makePromo({ id: `p${i}`, status, eligibility: { first_purchase: true } }),
    );
    const applied = evaluatePromos({ cart: makeCart(), candidates, now: NOW });
    expect(applied).toEqual([]);
  });
});

describe("evaluatePromos — stacking rules", () => {
  it("exclusive promo locks out a stackable one when exclusive ranks higher", () => {
    const applied = evaluatePromos({
      cart: makeCart({ client_orders_count: 0 }),
      candidates: [
        makePromo({ id: "ex", stacking_rule: "exclusive", discount_value: 15, eligibility: { first_purchase: true } }),
        makePromo({ id: "any", stacking_rule: "stackable_with_any", name: "Stackable", discount_value: 5 }),
      ],
      now: NOW,
    });

    expect(applied.map((a) => a.promotion_id)).toEqual(["ex"]);
  });

  it("two stackable_with_any promos can both land", () => {
    const applied = evaluatePromos({
      cart: makeCart(),
      candidates: [
        makePromo({ id: "a", stacking_rule: "stackable_with_any", name: "Alpha", discount_value: 5 }),
        makePromo({ id: "b", stacking_rule: "stackable_with_any", name: "Beta", discount_value: 3 }),
      ],
      now: NOW,
    });

    expect(applied.map((a) => a.promotion_id).sort()).toEqual(["a", "b"]);
  });

  it("an exclusive order-total promo does NOT suppress free shipping (separate lane)", () => {
    const applied = evaluatePromos({
      cart: makeCart({ cart_mode: "subscription", client_subscription_orders_count: 0, shipping_amount_minor: 990 }),
      candidates: [
        makePromo({
          id: "first-sub-50",
          name: "First Subscription 50%",
          stacking_rule: "exclusive",
          discount_value: 50,
          applies_to_payload: { cart_mode: "subscription" },
          eligibility: { first_subscription_purchase: true },
        }),
        makePromo({
          id: "sub-free-ship",
          name: "Subscription Free Shipping",
          discount_type: "free_shipping",
          stacking_rule: "stackable_with_any",
          applies_to_payload: { cart_mode: "subscription" },
        }),
      ],
      now: NOW,
    });

    expect(applied.map((a) => a.promotion_id).sort()).toEqual(["first-sub-50", "sub-free-ship"]);
    const ship = applied.find((a) => a.discount_type === "free_shipping");
    expect(ship?.amount_off_minor).toBe(990);
  });
});

describe("evaluatePromos — per-mode first-order eligibility", () => {
  it("first_subscription_purchase ignores prior one-time (bundle) orders", () => {
    const applied = evaluatePromos({
      cart: makeCart({
        cart_mode: "subscription",
        client_subscription_orders_count: 0,
        client_onetime_orders_count: 3,
      }),
      candidates: [
        makePromo({
          id: "first-sub",
          name: "First Subscription 50%",
          discount_value: 50,
          applies_to_payload: { cart_mode: "subscription" },
          eligibility: { first_subscription_purchase: true },
        }),
      ],
      now: NOW,
    });

    expect(applied.map((a) => a.promotion_id)).toEqual(["first-sub"]);
  });

  it("first_subscription_purchase is rejected once a subscription order exists", () => {
    const applied = evaluatePromos({
      cart: makeCart({ cart_mode: "subscription", client_subscription_orders_count: 1 }),
      candidates: [
        makePromo({
          id: "first-sub",
          applies_to_payload: { cart_mode: "subscription" },
          eligibility: { first_subscription_purchase: true },
        }),
      ],
      now: NOW,
    });

    expect(applied).toHaveLength(0);
  });

  it("device guard denies a first-order promo when the device already paid a first order", () => {
    const applied = evaluatePromos({
      cart: makeCart({
        cart_mode: "one_time",
        client_onetime_orders_count: 0,
        device_first_order_redeemed: true,
      }),
      candidates: [
        makePromo({
          id: "first-bundle",
          applies_to_payload: { cart_mode: "one_time" },
          eligibility: { first_onetime_purchase: true },
        }),
      ],
      now: NOW,
    });

    expect(applied).toHaveLength(0);
  });

  it("email-confirmed eligibility overrides the device guard for a first-order promo", () => {
    const applied = evaluatePromos({
      cart: makeCart({
        cart_mode: "one_time",
        client_onetime_orders_count: 0,
        device_first_order_redeemed: true,
        email_eligibility_confirmed: true,
      }),
      candidates: [
        makePromo({
          id: "first-bundle",
          applies_to_payload: { cart_mode: "one_time" },
          eligibility: { first_onetime_purchase: true },
        }),
      ],
      now: NOW,
    });

    expect(applied.map((a) => a.promotion_id)).toEqual(["first-bundle"]);
  });

  it("device guard still denies when the email-confirmed client already has a paid order", () => {
    const applied = evaluatePromos({
      cart: makeCart({
        cart_mode: "one_time",
        client_onetime_orders_count: 1,
        device_first_order_redeemed: true,
        email_eligibility_confirmed: true,
      }),
      candidates: [
        makePromo({
          id: "first-bundle",
          applies_to_payload: { cart_mode: "one_time" },
          eligibility: { first_onetime_purchase: true },
        }),
      ],
      now: NOW,
    });

    expect(applied).toHaveLength(0);
  });

  it("device guard does NOT affect a non-first-order promo", () => {
    const applied = evaluatePromos({
      cart: makeCart({ cart_mode: "one_time", device_first_order_redeemed: true, cart_subtotal_minor: 20000 }),
      candidates: [
        makePromo({
          id: "bundle-5",
          name: "Bundle 5%",
          discount_value: 5,
          stacking_rule: "stackable_with_any",
          applies_to_payload: { cart_mode: "one_time" },
          eligibility: { min_cart_minor: 12000 },
        }),
      ],
      now: NOW,
    });

    expect(applied.map((a) => a.promotion_id)).toEqual(["bundle-5"]);
  });

  it("first_onetime_purchase ignores prior subscription orders", () => {
    const applied = evaluatePromos({
      cart: makeCart({
        cart_mode: "one_time",
        client_onetime_orders_count: 0,
        client_subscription_orders_count: 2,
      }),
      candidates: [
        makePromo({
          id: "first-bundle",
          name: "First Purchase 10%",
          applies_to_payload: { cart_mode: "one_time" },
          eligibility: { first_onetime_purchase: true },
        }),
      ],
      now: NOW,
    });

    expect(applied.map((a) => a.promotion_id)).toEqual(["first-bundle"]);
  });
});

describe("promoEligibilityFailure — rejection classification", () => {
  it("returns null for an eligible promo", () => {
    expect(promoEligibilityFailure(makePromo({ eligibility: {} }), makeCart(), NOW)).toBeNull();
  });

  it("flags expired when outside the valid window", () => {
    const promo = makePromo({ valid_to: "2026-06-02T00:00:00Z" });
    expect(promoEligibilityFailure(promo, makeCart(), NOW)).toBe("expired");
  });

  it("flags not_eligible for a returning customer on a first-purchase promo", () => {
    const promo = makePromo({ eligibility: { first_purchase: true } });
    expect(promoEligibilityFailure(promo, makeCart({ client_orders_count: 2 }), NOW)).toBe("not_eligible");
  });

  it("flags not_eligible outside the cart region", () => {
    const promo = makePromo({ region_availability: ["DE"] });
    expect(promoEligibilityFailure(promo, makeCart(), NOW)).toBe("not_eligible");
  });
});
