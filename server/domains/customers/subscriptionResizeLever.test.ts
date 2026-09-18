import { describe, expect, it } from "vitest";

import {
  normalizeResizeLever,
  readPositiveInt,
  readResizeLever,
  resolveBundleCadence,
} from "./subscriptionResizeLever.js";

describe("subscription resize lever helpers", () => {
  // One nominal-plan constraint shape, parameterised by the nominal length.
  const constraintOf = (value: number) => ({ kind: "feeding_days" as const, value, dailyKcalOverride: 300 });

  it("parses resize levers and positive ints fail-closed", () => {
    expect(readResizeLever({ kind: "planLength", value: 14 })).toEqual({ kind: "planLength", value: 14 });
    expect(() => readResizeLever({ value: 14 })).toThrow("subscription_reprice_invalid_resize_lever");
    expect(readPositiveInt(14)).toBe(14);
    expect(readPositiveInt("bad")).toBeNull();
  });

  it("normalizes bare portion-mode levers with the current cadence", () => {
    expect(normalizeResizeLever(
      { kind: "portionMode", value: "topper" },
      undefined,
      28,
    )).toEqual({ kind: "portionMode", value: { portionMode: "topper", planDays: 28 } });

    expect(normalizeResizeLever(
      { kind: "portionMode", value: { portionMode: "full", planDays: 21 } },
      14,
      28,
    )).toEqual({ kind: "portionMode", value: { portionMode: "full", planDays: 21 } });
  });

  it("distinguishes a nominal package plan from its extended delivery cadence", () => {
    const constraint = constraintOf(14);

    expect(resolveBundleCadence("update_package_template", 14, 30, constraint)).toEqual({
      cadenceDays: 30,
      resizeLeverKind: "planLengthConstraint",
      requiresPlanResize: false,
      preservesFixedTotal: true,
    });
    // A cadence change from the package editor moves the cadence and stamps the
    // new nominal plan length, but never recomputes the composition.
    expect(resolveBundleCadence("update_package_template", 21, 30, constraint)).toEqual({
      cadenceDays: 21,
      resizeLeverKind: "planLengthConstraint",
      requiresPlanResize: false,
      preservesFixedTotal: false,
    });
  });

  it("keeps the sizing resize for genuine bundle callers when the cadence changes", () => {
    const constraint = constraintOf(28);

    expect(resolveBundleCadence(undefined, 14, 28, constraint)).toEqual({
      cadenceDays: 14,
      resizeLeverKind: "planLength",
      requiresPlanResize: true,
      preservesFixedTotal: false,
    });
    expect(resolveBundleCadence("update_recipe_mix", null, 28, constraint)).toEqual({
      cadenceDays: 28,
      resizeLeverKind: "planLengthConstraint",
      requiresPlanResize: false,
      preservesFixedTotal: true,
    });
  });
});
