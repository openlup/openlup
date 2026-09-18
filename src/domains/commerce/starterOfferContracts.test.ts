import { describe, expect, it } from "vitest";
import {
  customerEligibilityLookupRequestSchema,
  customerEligibilityLookupResponseSchema,
} from "./customerEligibilityContracts.js";
import {
  starterOfferIntentSchema,
  starterOfferResponseFor,
  starterOfferResponseSchema,
  starterPackPlanSchema,
} from "./starterOfferContracts.js";
import { STARTER_OFFER_CAPABILITY } from "./starterOfferPolicy.js";

/**
 * The exact response body this endpoint minted BEFORE the starter-offer field
 * existed. It must keep parsing against the `.strict()` schema forever — that is
 * the whole reason `starterOffer` is optional rather than a version bump.
 */
const PRE_CHANGE_RESPONSE = {
  contractVersion: "customer_eligibility.lookup.v1",
  recognized: false,
  firstOrderEligible: true,
} as const;

describe("customer eligibility contract, additive starter field", () => {
  it("still parses a response minted before the field existed", () => {
    const parsed = customerEligibilityLookupResponseSchema.parse(PRE_CHANGE_RESPONSE);
    expect(parsed).toEqual(PRE_CHANGE_RESPONSE);
    expect("starterOffer" in parsed).toBe(false);
  });

  it("still rejects an unknown key", () => {
    expect(
      customerEligibilityLookupResponseSchema.safeParse({
        ...PRE_CHANGE_RESPONSE,
        somethingElse: true,
      }).success,
    ).toBe(false);
  });

  it("accepts the starter offer when present", () => {
    const parsed = customerEligibilityLookupResponseSchema.parse({
      ...PRE_CHANGE_RESPONSE,
      starterOffer: starterOfferResponseFor(true),
    });
    expect(parsed.starterOffer).toEqual({
      eligible: true,
      initialDiscountBps: 5_000,
      delivery2DiscountBps: 3_500,
      minCans: 14,
      intervalMinDays: 7,
      intervalMaxDays: 28,
      steadyCadenceThresholdGramsPerDay: 800,
      maxDailyGrams: 1_500,
    });
  });

  it("rejects an unknown key inside the starter offer", () => {
    expect(
      starterOfferResponseSchema.safeParse({ ...starterOfferResponseFor(true), extra: 1 }).success,
    ).toBe(false);
  });

  it("accepts the capability on the request and rejects any other token", () => {
    const base = { email: "a@example.com" };
    expect(
      customerEligibilityLookupRequestSchema.parse({
        ...base,
        offerModeCapability: STARTER_OFFER_CAPABILITY,
      }).offerModeCapability,
    ).toBe(STARTER_OFFER_CAPABILITY);
    expect(customerEligibilityLookupRequestSchema.parse(base).offerModeCapability).toBeUndefined();
    expect(
      customerEligibilityLookupRequestSchema.safeParse({
        ...base,
        offerModeCapability: "commerce.starter_offer.v2",
      }).success,
    ).toBe(false);
  });
});

describe("starterOfferIntentSchema", () => {
  const VALID = {
    capability: STARTER_OFFER_CAPABILITY,
    intervalDays: 14,
    delivery2DiscountBps: 3_500,
    steady: { cadenceDays: 28, cans: 14 },
  };

  it("accepts a well-formed intent", () => {
    expect(starterOfferIntentSchema.parse(VALID)).toEqual(VALID);
  });

  it.each([
    ["wrong capability", { ...VALID, capability: "commerce.starter_offer.v0" }],
    ["interval below 7", { ...VALID, intervalDays: 6 }],
    ["interval above 28", { ...VALID, intervalDays: 29 }],
    ["non-integer interval", { ...VALID, intervalDays: 14.5 }],
    ["bps above 10000", { ...VALID, delivery2DiscountBps: 10_001 }],
    ["negative bps", { ...VALID, delivery2DiscountBps: -1 }],
    ["cadence 21", { ...VALID, steady: { cadenceDays: 21, cans: 14 } }],
    ["zero cans", { ...VALID, steady: { cadenceDays: 14, cans: 0 } }],
    ["unknown top-level key", { ...VALID, sneaky: true }],
    ["unknown steady key", { ...VALID, steady: { cadenceDays: 14, cans: 14, sneaky: true } }],
  ])("rejects %s", (_label, payload) => {
    expect(starterOfferIntentSchema.safeParse(payload).success).toBe(false);
  });
});

describe("starterPackPlanSchema", () => {
  const PLAN = {
    schemaVersion: "1",
    starterIntervalDays: 14,
    basisTemplateVersion: 1,
    delivery2: { discountBps: 3_500, discountMinor: 3_000, basisSubtotalMinor: 16_000 },
    graduation: {
      cadenceDays: 28,
      lines: [
        { sku: "SKU-1", qty: 14, sortOrder: 0, isAddon: false, quoteLine: { lineSubtotalGross: 1 } },
      ],
    },
  };

  it("accepts the frozen plan shape", () => {
    expect(starterPackPlanSchema.parse(PLAN)).toEqual(PLAN);
  });

  it("strips unknown keys rather than rejecting them (matches the migration)", () => {
    const parsed = starterPackPlanSchema.parse({ ...PLAN, unknown: "dropped" });
    expect(parsed).toEqual(PLAN);
  });

  it.each([
    ["schemaVersion 1 as a number", { ...PLAN, schemaVersion: 1 }],
    ["interval out of range", { ...PLAN, starterIntervalDays: 29 }],
    ["basisTemplateVersion 0", { ...PLAN, basisTemplateVersion: 0 }],
    ["bps above 10000", { ...PLAN, delivery2: { ...PLAN.delivery2, discountBps: 10_001 } }],
    ["negative discountMinor", { ...PLAN, delivery2: { ...PLAN.delivery2, discountMinor: -1 } }],
    ["cadence 21", { ...PLAN, graduation: { ...PLAN.graduation, cadenceDays: 21 } }],
    ["no lines", { ...PLAN, graduation: { ...PLAN.graduation, lines: [] } }],
  ])("rejects %s", (_label, payload) => {
    expect(starterPackPlanSchema.safeParse(payload).success).toBe(false);
  });

  /**
   * P1-2: the frozen plan may not promise a basket size its own lines
   * contradict. The graduation RPC writes BOTH the size constraint and the
   * lines, so a plan that disagrees with itself settles the subscription on a
   * package the customer was never quoted.
   */
  describe("unit_count size constraint must match the line total", () => {
    const withConstraint = (value: number, quantities: number[]) => ({
      ...PLAN,
      graduation: {
        ...PLAN.graduation,
        sizeConstraint: { kind: "unit_count", value },
        lines: quantities.map((qty, index) => ({
          ...PLAN.graduation.lines[0],
          sku: `SKU-${index}`,
          sortOrder: index,
          qty,
        })),
      },
    });

    it("accepts a plan whose lines add up", () => {
      expect(starterPackPlanSchema.safeParse(withConstraint(28, [20, 8])).success).toBe(true);
    });

    it("rejects the reviewer's counterexample: promises 28, ships 29", () => {
      const result = starterPackPlanSchema.safeParse(withConstraint(28, Array(29).fill(1)));
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0].message).toContain("29");
      expect(result.error.issues[0].message).toContain("28");
      expect(result.error.issues[0].path).toEqual(["graduation", "lines"]);
    });

    it("rejects an undershoot as well as an overshoot", () => {
      expect(starterPackPlanSchema.safeParse(withConstraint(28, [27])).success).toBe(false);
    });

    it("ignores a size constraint of another kind, and one with no numeric value", () => {
      const otherKind = {
        ...PLAN,
        graduation: { ...PLAN.graduation, sizeConstraint: { kind: "feeding_days", value: 28 } },
      };
      expect(starterPackPlanSchema.safeParse(otherKind).success).toBe(true);
      const noValue = {
        ...PLAN,
        graduation: { ...PLAN.graduation, sizeConstraint: { kind: "unit_count" } },
      };
      expect(starterPackPlanSchema.safeParse(noValue).success).toBe(true);
    });

    it("does not fire when there is no size constraint at all", () => {
      expect(starterPackPlanSchema.safeParse(PLAN).success).toBe(true);
    });
  });
});
