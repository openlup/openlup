import { expect, it, vi } from "vitest";
import { apportionSubscriptionUnits, createSubscriptionSizingRules } from "../../src/subscriptions/subscriptionSizing.js";
const unit = (variantId: string, demandPerUnit = 10, maximumQuantity = 99) => ({ variantId, demandPerUnit, maximumQuantity });
it.each(["plan_days", "unit_count"])("restamps only a nominal plan constraint without sizing %s quantities", async kind => {
  const sizingRead = vi.fn(() => { throw new Error("constraint-only edits must not size quantities"); });
  const rules = createSubscriptionSizingRules({ portionModes: { full: { mode: "full", factor: 1 }, reduced: { mode: "portion", factor: 0.5 } },
    readDailyNeed: sizingRead, isPlanLengthConstraint: constraint => constraint.data.kind === "plan_days",
    readUnitFacts: sizingRead, quantityPolicy: sizingRead });
  const coreLines = [{ variantId: "a", qty: 4, isAddon: false }, { variantId: "b", qty: 2, isAddon: false }];
  const constraint = { kind: "configured", version: 1, data: { kind, value: 28, mode: "portion", portionFactor: 0.5, marker: "keep" } };
  const result = await rules.resizeComposition({ coreLines, constraint, lever: { kind: "planLengthConstraint", value: 14.9 } });
  expect(result).toEqual({ coreLines, constraint: { ...constraint, data: { ...constraint.data, value: kind === "plan_days" ? 14 : 28 } } });
  expect(result?.coreLines).toBe(coreLines);
  expect(constraint.data.value).toBe(28);
  expect(sizingRead).not.toHaveBeenCalled();
});
it.each([0, -1, 0.5, NaN, Infinity, undefined, ""])("refuses invalid constraint-only plan %s", async value => {
  const sizingRead = vi.fn(() => { throw new Error("invalid plans must refuse before sizing"); });
  const rules = createSubscriptionSizingRules({ portionModes: { full: { mode: "full", factor: 1 }, reduced: { mode: "portion", factor: 0.5 } },
    readDailyNeed: sizingRead, isPlanLengthConstraint: () => true, readUnitFacts: sizingRead, quantityPolicy: sizingRead });
  await expect(rules.resizeComposition({ coreLines: [{ variantId: "a", qty: 4, isAddon: false }],
    constraint: { kind: "configured", version: 1, data: { value: 28 } }, lever: { kind: "planLengthConstraint", value } }))
    .rejects.toThrow("subscription_reprice_invalid_plan_length");
  expect(sizingRead).not.toHaveBeenCalled();
});
it.each([
  [7, [3, 1], [5, 2]], [5, [1, 1], [3, 2]], [3, [10, 1, 1], [1, 1, 1]],
] as const)("apportions %s units with deterministic remainder and selection preservation", (totalUnits, quantities, expected) => {
  const current = quantities.map((qty, index) => ({ variantId: String(index), qty }));
  expect(apportionSubscriptionUnits({ totalUnits, current, units: current.map(line => unit(line.variantId)), targetDemand: 0 }).map(line => line.qty)).toEqual(expected);
});
it("redistributes limited capacity without dropping selected items", () => {
  expect(apportionSubscriptionUnits({ totalUnits: 6, targetDemand: 0, current: [{ variantId: "a", qty: 3 }, { variantId: "b", qty: 1 }],
    units: [unit("a", 10, 2), unit("b")] })).toEqual([{ variantId: "a", qty: 2 }, { variantId: "b", qty: 4 }]);
});
it("raises demand coverage through a deterministic transfer and refuses unreachable coverage", () => {
  const input = { totalUnits: 4, targetDemand: 100, current: [{ variantId: "a", qty: 3 }, { variantId: "b", qty: 1 }], units: [unit("a", 10), unit("b", 40)] };
  expect(apportionSubscriptionUnits(input)).toEqual([{ variantId: "a", qty: 2 }, { variantId: "b", qty: 2 }]);
  expect(apportionSubscriptionUnits({ ...input, targetDemand: 200 })).toEqual([]);
});
it.each([0, 1, 5])("refuses unservable total %s with every selected item required", totalUnits => {
  expect(apportionSubscriptionUnits({ totalUnits, targetDemand: 0, current: [{ variantId: "a", qty: 1 }, { variantId: "b", qty: 1 }],
    units: [unit("a", 10, 2), unit("b", 10, 2)] })).toEqual([]);
});
it("refuses invalid totals, missing selected facts and duplicate current selection", () => {
  const input = { totalUnits: 2, targetDemand: 0, current: [{ variantId: "a", qty: 1 }], units: [unit("a")] };
  expect(() => apportionSubscriptionUnits({ ...input, totalUnits: 1.5 })).toThrow("invalid_sizing_total");
  expect(() => apportionSubscriptionUnits({ ...input, units: [] })).toThrow("invalid_current_mix");
  expect(() => apportionSubscriptionUnits({ ...input, current: [...input.current, ...input.current] })).toThrow("invalid_current_mix");
});
it("uses configured factors and refuses the host policy's capacity-constrained result", async () => {
  const constraint = { kind: "host", version: 1, data: { need: 10, portionFactor: 2 } };
  const rules = createSubscriptionSizingRules({ portionModes: { full: { mode: "complete", factor: 2 }, reduced: { mode: "partial", factor: 0.75 } },
    readDailyNeed: value => Number(value.data.need), isPlanLengthConstraint: () => false,
    readUnitFacts: async () => [unit("a")], quantityPolicy: async input => { expect(input.dailyNeed).toBe(7.5); return { totalUnits: 3, maxExceeded: false, selectedCapacityConstrained: true }; } });
  await expect(rules.resizeComposition({ coreLines: [{ variantId: "a", qty: 10, isAddon: false }], constraint,
    lever: { kind: "portionMode", value: { portionMode: "partial", planDays: 5 } } })).rejects.toThrow("subscription_reprice_portion_unservable");
  expect(await rules.resizeComposition({ coreLines: [], constraint, lever: { kind: "unknown", value: 5 } })).toBeNull();
});
it("supplies quantity policy facts in selected order even when the host read is reordered", async () => {
  const rules = createSubscriptionSizingRules({ portionModes: { full: { mode: "full", factor: 1 }, reduced: { mode: "portion", factor: 0.5 } },
    readDailyNeed: () => 1, isPlanLengthConstraint: () => true, readUnitFacts: async () => [unit("b"), unit("a")],
    quantityPolicy: async input => { expect(input.units.map(value => value.variantId)).toEqual(["a", "b"]); return { totalUnits: 3, maxExceeded: false }; } });
  expect(await rules.resizeComposition({ coreLines: [{ variantId: "a", qty: 1, isAddon: false }, { variantId: "b", qty: 1, isAddon: false }],
    constraint: { kind: "configured", version: 1, data: {} }, lever: { kind: "planLength", value: 2 } }))
    .toMatchObject({ coreLines: [{ variantId: "a", qty: 2 }, { variantId: "b", qty: 1 }] });
});
