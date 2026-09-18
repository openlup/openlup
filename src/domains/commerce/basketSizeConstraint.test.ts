import { describe, expect, it } from "vitest";
import {
  type BasketLineForValidator,
  type BasketSizeConstraint,
  validateBasketSizeConstraint,
  validateCartModeConsistency,
} from "./basketSizeConstraint.js";

function makeLine(overrides: Partial<BasketLineForValidator> = {}): BasketLineForValidator {
  return {
    variant_id: "variant-lamb",
    qty: 1,
    is_addon: false,
    net_weight_g: 400,
    kcal_per_unit: 492,
    mode_at_line: "one_time",
    ...overrides,
  };
}

describe("validateBasketSizeConstraint — unit_count (v1 active kind)", () => {
  it("passes when eligible food lines sum exactly to the bundle value", () => {
    const constraint: BasketSizeConstraint = { kind: "unit_count", value: 14 };
    const lines = [
      makeLine({ variant_id: "lamb", qty: 7 }),
      makeLine({ variant_id: "beef", qty: 7 }),
    ];

    expect(validateBasketSizeConstraint(constraint, lines)).toEqual({ ok: true });
  });

  it("ignores add-on lines from the count", () => {
    const constraint: BasketSizeConstraint = { kind: "unit_count", value: 14 };
    const lines = [
      makeLine({ variant_id: "lamb", qty: 14 }),
      makeLine({ variant_id: "treat", qty: 2, is_addon: true }),
    ];

    expect(validateBasketSizeConstraint(constraint, lines)).toEqual({ ok: true });
  });

  it("fails when the food lines miss the value by even one", () => {
    const constraint: BasketSizeConstraint = { kind: "unit_count", value: 14 };
    const lines = [makeLine({ variant_id: "lamb", qty: 13 })];

    const result = validateBasketSizeConstraint(constraint, lines);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason_code).toBe("unit_count_mismatch");
      expect(result.message).toContain("13");
      expect(result.message).toContain("14");
    }
  });
});

describe("validateBasketSizeConstraint — weight and feeding-day kinds", () => {
  it("passes when food lines sum to the required total weight", () => {
    const constraint: BasketSizeConstraint = { kind: "total_weight_g", value: 5600 };
    const lines = [
      makeLine({ variant_id: "lamb-400", qty: 10, net_weight_g: 400 }),
      makeLine({ variant_id: "beef-800", qty: 2, net_weight_g: 800 }),
      makeLine({ variant_id: "treat", qty: 3, is_addon: true, net_weight_g: 50 }),
    ];

    expect(validateBasketSizeConstraint(constraint, lines)).toEqual({ ok: true });
  });

  it("fails deterministically when food-line weight misses the constraint", () => {
    const constraint: BasketSizeConstraint = { kind: "total_weight_g", value: 5600 };
    const lines = [makeLine({ qty: 13, net_weight_g: 400 })];

    const result = validateBasketSizeConstraint(constraint, lines);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason_code).toBe("total_weight_g_mismatch");
      expect(result.message).toContain("5200");
      expect(result.message).toContain("5600");
    }
  });

  it("passes feeding-days when calories cover the requested days within tolerance", () => {
    const constraint: BasketSizeConstraint = {
      kind: "feeding_days",
      value: 21,
      pet_id: "pet-rex",
      daily_kcal_override: 328,
    };
    const lines = [makeLine({ qty: 14, kcal_per_unit: 492 })];

    expect(validateBasketSizeConstraint(constraint, lines)).toEqual({ ok: true });
  });

  it("requires daily kcal for feeding-days validation", () => {
    const constraint: BasketSizeConstraint = {
      kind: "feeding_days",
      value: 21,
      pet_id: "pet-rex",
    };
    const lines = [makeLine({ qty: 14, kcal_per_unit: 492 })];

    const result = validateBasketSizeConstraint(constraint, lines);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason_code).toBe("missing_daily_kcal");
    }
  });

  it("returns unknown_kind for malformed constraint payloads", () => {
    const constraint = { kind: "made_up_kind", value: 1 } as unknown as BasketSizeConstraint;

    const result = validateBasketSizeConstraint(constraint, []);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason_code).toBe("unknown_kind");
    }
  });
});

describe("validateCartModeConsistency invariant", () => {
  it("passes when cart.mode='one_time' and all lines are one_time", () => {
    const result = validateCartModeConsistency("one_time", [
      makeLine({ mode_at_line: "one_time" }),
      makeLine({ variant_id: "treat", mode_at_line: "one_time", is_addon: true }),
    ]);

    expect(result.ok).toBe(true);
  });

  it("fails when cart.mode='one_time' but a line is subscription", () => {
    const result = validateCartModeConsistency("one_time", [
      makeLine({ variant_id: "lamb", mode_at_line: "one_time" }),
      makeLine({ variant_id: "beef", mode_at_line: "subscription" }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.offending_lines).toEqual(["beef"]);
    }
  });

  it("passes when cart.mode='subscription' and all lines are subscription template lines", () => {
    const result = validateCartModeConsistency("subscription", [
      makeLine({ variant_id: "lamb", mode_at_line: "subscription" }),
      makeLine({ variant_id: "treat", mode_at_line: "subscription", is_addon: true }),
    ]);

    expect(result.ok).toBe(true);
  });

  it("fails when cart.mode='subscription' but an ad-hoc add-on is one_time", () => {
    const result = validateCartModeConsistency("subscription", [
      makeLine({ variant_id: "lamb", mode_at_line: "subscription" }),
      makeLine({ variant_id: "treat", mode_at_line: "one_time", is_addon: true }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.offending_lines).toEqual(["treat"]);
    }
  });
});
