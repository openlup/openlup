import { describe, expect, it } from "vitest";
import { starterPackPlanSchema } from "../../../src/domains/commerce/contracts.js";
import { starterPackMarkerSchema } from "./starterPackCycle.js";

/**
 * The starter-pack marker shape exists TWICE on purpose:
 *
 *  - `starterPackPlanSchema` (`src/domains/commerce`) is what the checkout guard
 *    mints and freezes into `quote.context.starterPack`. It lives under `src/**`
 *    because the browser bundle reaches the same commerce contracts.
 *  - `starterPackMarkerSchema` (`server/domains/subscription`) is what the
 *    renewal engine reads back out of `subscriptions.starter_pack`.
 *
 * Neither can import the other: `src/lib/architectureGuardrails.test.ts` blocks a
 * cross-domain reach into another domain's internals, and the browser bundle can
 * never hold a server module. The plan schema is therefore re-exported on
 * commerce's PUBLIC `contracts.ts` surface — the same sanctioned route wave 1
 * used for `splitIncludedVat` — and this file drives both schemas over one set
 * of fixtures.
 *
 * ⛔ If this file fails, one of the two schemas moved without the other. Fix the
 * schema, not the fixture: a plan the migration would reject, or a stored marker
 * the renewal engine cannot parse, is a charged customer with a broken
 * subscription.
 */

const VALID_PLAN = {
  schemaVersion: "1",
  starterIntervalDays: 14,
  basisTemplateVersion: 1,
  delivery2: { discountBps: 3_500, discountMinor: 3_150, basisSubtotalMinor: 16_800 },
  graduation: {
    cadenceDays: 28,
    sizeConstraint: { kind: "unit_count", value: 28 },
    lines: [
      {
        sku: "opaque:lamb-launch.v1",
        qty: 28,
        sortOrder: 0,
        isAddon: false,
        quoteLine: {
          sku: "opaque:lamb-launch.v1",
          productSlug: "lamb",
          quantity: 28,
          unitPriceGross: { amountMinor: 1_000, currency: "PLN" },
          lineSubtotalGross: { amountMinor: 28_000, currency: "PLN" },
        },
      },
    ],
  },
};

/** Every boundary both schemas claim to enforce, driven from one table. */
const ACCEPTED: Array<[label: string, value: unknown]> = [
  ["the canonical plan", VALID_PLAN],
  ["no sizeConstraint", { ...VALID_PLAN, graduation: { cadenceDays: 28, lines: VALID_PLAN.graduation.lines } }],
  ["interval at the 7-day floor", { ...VALID_PLAN, starterIntervalDays: 7 }],
  ["interval at the 28-day ceiling", { ...VALID_PLAN, starterIntervalDays: 28 }],
  ["a zero delivery-2 discount", { ...VALID_PLAN, delivery2: { ...VALID_PLAN.delivery2, discountMinor: 0, discountBps: 0 } }],
  ["the 10000 bps ceiling", { ...VALID_PLAN, delivery2: { ...VALID_PLAN.delivery2, discountBps: 10_000 } }],
  ["a fortnightly graduation", { ...VALID_PLAN, graduation: { ...VALID_PLAN.graduation, cadenceDays: 14 } }],
  ["an addon line", {
    ...VALID_PLAN,
    graduation: {
      ...VALID_PLAN.graduation,
      lines: [{ ...VALID_PLAN.graduation.lines[0], isAddon: true }],
    },
  }],
];

const REJECTED: Array<[label: string, value: unknown]> = [
  ["a numeric schemaVersion", { ...VALID_PLAN, schemaVersion: 1 }],
  ["schemaVersion 2", { ...VALID_PLAN, schemaVersion: "2" }],
  ["an interval below 7", { ...VALID_PLAN, starterIntervalDays: 6 }],
  ["an interval above 28", { ...VALID_PLAN, starterIntervalDays: 29 }],
  ["a fractional interval", { ...VALID_PLAN, starterIntervalDays: 14.5 }],
  ["basisTemplateVersion 0", { ...VALID_PLAN, basisTemplateVersion: 0 }],
  ["bps above 10000", { ...VALID_PLAN, delivery2: { ...VALID_PLAN.delivery2, discountBps: 10_001 } }],
  ["a negative discountMinor", { ...VALID_PLAN, delivery2: { ...VALID_PLAN.delivery2, discountMinor: -1 } }],
  ["a negative basisSubtotalMinor", { ...VALID_PLAN, delivery2: { ...VALID_PLAN.delivery2, basisSubtotalMinor: -1 } }],
  ["a missing delivery2", { ...VALID_PLAN, delivery2: undefined }],
  ["a 21-day graduation cadence", { ...VALID_PLAN, graduation: { ...VALID_PLAN.graduation, cadenceDays: 21 } }],
  ["an empty line list", { ...VALID_PLAN, graduation: { ...VALID_PLAN.graduation, lines: [] } }],
  ["a blank sku", {
    ...VALID_PLAN,
    graduation: { ...VALID_PLAN.graduation, lines: [{ ...VALID_PLAN.graduation.lines[0], sku: "" }] },
  }],
  ["qty 0", {
    ...VALID_PLAN,
    graduation: { ...VALID_PLAN.graduation, lines: [{ ...VALID_PLAN.graduation.lines[0], qty: 0 }] },
  }],
  ["a negative sortOrder", {
    ...VALID_PLAN,
    graduation: { ...VALID_PLAN.graduation, lines: [{ ...VALID_PLAN.graduation.lines[0], sortOrder: -1 }] },
  }],
  ["a non-object quoteLine", {
    ...VALID_PLAN,
    graduation: { ...VALID_PLAN.graduation, lines: [{ ...VALID_PLAN.graduation.lines[0], quoteLine: "nope" }] },
  }],
  ["a non-object plan", "nope"],
  ["null", null],
];

describe("starter-pack marker schema parity (commerce plan <-> subscription marker)", () => {
  it.each(ACCEPTED)("both schemas accept %s", (_label, value) => {
    expect(starterPackPlanSchema.safeParse(value).success).toBe(true);
    expect(starterPackMarkerSchema.safeParse(value).success).toBe(true);
  });

  it.each(REJECTED)("both schemas reject %s", (_label, value) => {
    expect(starterPackPlanSchema.safeParse(value).success).toBe(false);
    expect(starterPackMarkerSchema.safeParse(value).success).toBe(false);
  });

  it("both strip unknown keys identically (the migration rebuilds from validated fields)", () => {
    const withNoise = { ...VALID_PLAN, unknownTop: 1, delivery2: { ...VALID_PLAN.delivery2, noise: 2 } };
    const plan = starterPackPlanSchema.parse(withNoise);
    const marker = starterPackMarkerSchema.parse(withNoise);
    expect(plan).toEqual(marker);
    expect(plan).toEqual(VALID_PLAN);
  });

  it("round-trips the guard's own output through the renewal engine's schema", () => {
    const parsed = starterPackPlanSchema.parse(VALID_PLAN);
    expect(starterPackMarkerSchema.parse(parsed)).toEqual(parsed);
  });

  /**
   * The ONE deliberate asymmetry (P1-2 rework). The MINT side gained a
   * cross-field refine — a `unit_count` size constraint must equal the line
   * total — because the guard is the only writer and a self-contradicting plan
   * must never be stored. The READ side is deliberately NOT tightened: making a
   * stored marker unparseable would throw inside the renewal engine and strand a
   * live subscription mid-cycle, which is a worse failure than the one being
   * prevented. Mint-stricter-than-read is the safe direction.
   *
   * ⛔ This is the complete list of shapes the two schemas judge differently. If
   * a second one appears, it belongs here with its own reason — not absorbed by
   * relaxing the parity tables above.
   */
  it("is asymmetric in exactly one direction: the mint side rejects a self-contradicting basket size", () => {
    const contradictory = {
      ...VALID_PLAN,
      graduation: {
        ...VALID_PLAN.graduation,
        sizeConstraint: { kind: "unit_count", value: 28 },
        lines: Array.from({ length: 29 }, (_unused, index) => ({
          ...VALID_PLAN.graduation.lines[0],
          sku: `SKU-${index}`,
          sortOrder: index,
          qty: 1,
        })),
      },
    };

    expect(starterPackPlanSchema.safeParse(contradictory).success).toBe(false);
    expect(starterPackMarkerSchema.safeParse(contradictory).success).toBe(true);
  });
});
