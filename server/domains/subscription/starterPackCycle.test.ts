import { describe, expect, it } from "vitest";
import {
  deriveStarterPhase,
  resolveDelivery2DiscountMinor,
  starterPackMarkerSchema,
  type StarterPackMarker,
} from "./starterPackCycle.js";

const BASIS = 1;

function marker(overrides: Record<string, unknown> = {}): StarterPackMarker {
  return starterPackMarkerSchema.parse({
    schemaVersion: "1",
    starterIntervalDays: 17,
    basisTemplateVersion: BASIS,
    delivery2: { discountBps: 3500, discountMinor: 3430, basisSubtotalMinor: 9800 },
    graduation: {
      cadenceDays: 28,
      lines: [
        {
          sku: "VEL-LAMB-01",
          qty: 8,
          sortOrder: 0,
          isAddon: false,
          quoteLine: {
            unitPriceGross: { amountMinor: 1340, currency: "PLN" },
            lineSubtotalGross: { amountMinor: 10720, currency: "PLN" },
          },
        },
      ],
    },
    ...overrides,
  });
}

describe("starterPackMarkerSchema", () => {
  it("accepts the canonical marker the migration writes", () => {
    expect(starterPackMarkerSchema.safeParse(marker()).success).toBe(true);
  });

  it("requires schemaVersion to be the string '1', matching the column CHECK", () => {
    expect(starterPackMarkerSchema.safeParse({ ...marker(), schemaVersion: 1 }).success).toBe(false);
    expect(starterPackMarkerSchema.safeParse({ ...marker(), schemaVersion: "2" }).success).toBe(
      false,
    );
  });

  it.each([
    ["interval below the floor", { starterIntervalDays: 6 }],
    ["interval above the ceiling", { starterIntervalDays: 29 }],
    ["fractional interval", { starterIntervalDays: 17.5 }],
    ["basis template version below 1", { basisTemplateVersion: 0 }],
  ])("rejects %s", (_label, override) => {
    expect(starterPackMarkerSchema.safeParse({ ...marker(), ...override }).success).toBe(false);
  });

  it.each([
    ["a discount rate over 100%", { discountBps: 10_001, discountMinor: 0, basisSubtotalMinor: 1 }],
    ["a negative discount", { discountBps: 3500, discountMinor: -1, basisSubtotalMinor: 9800 }],
  ])("rejects delivery2 with %s", (_label, delivery2) => {
    expect(starterPackMarkerSchema.safeParse({ ...marker(), delivery2 }).success).toBe(false);
  });

  it("rejects a graduation cadence outside the steady set and an empty line set", () => {
    const base = marker();
    expect(
      starterPackMarkerSchema.safeParse({
        ...base,
        graduation: { ...base.graduation, cadenceDays: 21 },
      }).success,
    ).toBe(false);
    expect(
      starterPackMarkerSchema.safeParse({ ...base, graduation: { ...base.graduation, lines: [] } })
        .success,
    ).toBe(false);
  });

  it("rejects a graduation line missing its frozen quoteLine", () => {
    const base = marker();
    expect(
      starterPackMarkerSchema.safeParse({
        ...base,
        graduation: {
          ...base.graduation,
          lines: [{ sku: "X", qty: 1, sortOrder: 0, isAddon: false }],
        },
      }).success,
    ).toBe(false);
  });
});

describe("deriveStarterPhase", () => {
  const table: Array<{
    cycleNumber: number;
    templateVersion: number;
    withMarker: boolean;
    cadenceDays: number;
    expected: string;
  }> = [];
  for (const cycleNumber of [1, 2, 3, 4]) {
    for (const templateVersion of [BASIS, BASIS + 1]) {
      for (const withMarker of [false, true]) {
        const expected = !withMarker
          ? "none"
          : cycleNumber === 2
            ? "delivery2"
            : cycleNumber < 3
              ? "none"
              : templateVersion === BASIS
                ? "graduate_full"
                : "graduate_cadence_only";
        table.push({ cycleNumber, templateVersion, withMarker, cadenceDays: 17, expected });
      }
    }
  }

  it.each(table)(
    "cycle $cycleNumber / template $templateVersion / marker $withMarker -> $expected",
    ({ cycleNumber, templateVersion, withMarker, cadenceDays, expected }) => {
      expect(
        deriveStarterPhase({
          marker: withMarker ? marker() : null,
          cycleNumber,
          templateVersion,
          cadenceDays,
        }),
      ).toBe(expected);
    },
  );

  it.each([14, 21, 28])(
    "leaves a moved template alone when the customer already picked cadence %i",
    (cadenceDays) => {
      expect(
        deriveStarterPhase({
          marker: marker({ starterIntervalDays: cadenceDays }),
          cycleNumber: 3,
          templateVersion: BASIS + 1,
          cadenceDays,
        }),
      ).toBe("none");
    },
  );

  it("leaves a moved template alone when cadence is no longer the starter interval", () => {
    expect(
      deriveStarterPhase({
        marker: marker(),
        cycleNumber: 5,
        templateVersion: BASIS + 2,
        cadenceDays: 19,
      }),
    ).toBe("none");
  });
});

describe("resolveDelivery2DiscountMinor", () => {
  it("uses the exact frozen amount when template and subtotal both still match", () => {
    expect(
      resolveDelivery2DiscountMinor({ marker: marker(), templateVersion: BASIS, subtotalMinor: 9800 }),
    ).toBe(3430);
  });

  it("recomputes from bps when the subtotal moved", () => {
    // 12000 * 3500 / 10000 = 4200
    expect(
      resolveDelivery2DiscountMinor({
        marker: marker(),
        templateVersion: BASIS,
        subtotalMinor: 12_000,
      }),
    ).toBe(4200);
  });

  it("recomputes from bps when the template moved even at the frozen subtotal", () => {
    // 9800 * 3500 / 10000 = 3430 by arithmetic, but via the bps branch.
    expect(
      resolveDelivery2DiscountMinor({
        marker: marker({ delivery2: { discountBps: 3500, discountMinor: 9999, basisSubtotalMinor: 9800 } }),
        templateVersion: BASIS + 1,
        subtotalMinor: 9800,
      }),
    ).toBe(3430);
  });

  it("clamps so at least 100 minor units remain payable", () => {
    expect(
      resolveDelivery2DiscountMinor({
        marker: marker({ delivery2: { discountBps: 10_000, discountMinor: 0, basisSubtotalMinor: 1 } }),
        templateVersion: BASIS + 1,
        subtotalMinor: 500,
      }),
    ).toBe(400);
  });

  it("clamps to zero rather than negative when the subtotal is below the floor", () => {
    expect(
      resolveDelivery2DiscountMinor({
        marker: marker({ delivery2: { discountBps: 5000, discountMinor: 0, basisSubtotalMinor: 1 } }),
        templateVersion: BASIS + 1,
        subtotalMinor: 50,
      }),
    ).toBe(0);
  });

  it("returns an integer for a rate that does not divide evenly", () => {
    const value = resolveDelivery2DiscountMinor({
      marker: marker({ delivery2: { discountBps: 3333, discountMinor: 0, basisSubtotalMinor: 1 } }),
      templateVersion: BASIS + 1,
      subtotalMinor: 9801,
    });
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBe(Math.round((9801 * 3333) / 10_000));
  });
});
