import { describe, expect, it } from "vitest";
import {
  BUNDLE_ALLOCATION_FAILURE_CODES,
  DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR,
  allocateBundleTargetPrice,
  type AllocateBundleTargetPriceInput,
  type BundleAllocationResult,
  type BundleComponentInput,
} from "../src/pricing/index.js";

const CODES = ["UNIT-A", "UNIT-B", "UNIT-C", "UNIT-D", "UNIT-E", "UNIT-F"] as const;
// Rounding-hostile on purpose: primes and near-primes so the proportional split almost
// never divides evenly, plus a zero-priced component that must stay free.
const UNIT_PRICES = [0, 1, 3, 7, 97, 101, 499, 1009, 2503, 9973] as const;
const QUANTITIES = [1, 2, 3, 4, 5, 7, 11, 13, 23, 24] as const;
const MINIMUMS = [undefined, 0, 1, 5] as const;

interface MatrixCase {
  label: string;
  input: AllocateBundleTargetPriceInput;
  referenceTotal: number;
  floorTotal: number;
}

function buildCase(size: number, offset: number, targetPick: number, minimum: number | undefined): MatrixCase {
  const components: BundleComponentInput[] = Array.from({ length: size }, (_, index) => ({
    sku: CODES[index],
    unitPriceMinor: UNIT_PRICES[(offset + index * 3) % UNIT_PRICES.length],
    quantity: QUANTITIES[(offset + index * 7) % QUANTITIES.length],
  }));
  const referenceTotal = components.reduce((total, item) => total + item.unitPriceMinor * item.quantity, 0);
  const effectiveMinimum = minimum ?? DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR;
  const floorTotal = components.reduce(
    (total, item) => total + item.quantity * Math.min(effectiveMinimum, item.unitPriceMinor),
    0,
  );
  // Targets that stress the rounding edges: the whole sum, one minor unit under it,
  // the exact floor, and three interior points picked by prime ratios.
  const targets = [
    referenceTotal,
    referenceTotal - 1,
    floorTotal,
    Math.floor((referenceTotal * 7) / 13) + 1,
    Math.floor(referenceTotal / 2),
    Math.floor((referenceTotal * 11) / 97),
  ];
  const targetPriceMinor = Math.max(0, targets[targetPick % targets.length]);

  return {
    label: `size=${size} offset=${offset} target=${targetPriceMinor} minimum=${String(minimum)}`,
    input: {
      components,
      targetPriceMinor,
      ...(minimum === undefined ? {} : { minimumUnitPayableMinor: minimum }),
    },
    referenceTotal,
    floorTotal,
  };
}

const matrix: MatrixCase[] = [];
for (let size = 1; size <= CODES.length; size += 1) {
  for (let offset = 0; offset < UNIT_PRICES.length; offset += 1) {
    for (let targetPick = 0; targetPick < 6; targetPick += 1) {
      for (const minimum of MINIMUMS) matrix.push(buildCase(size, offset, targetPick, minimum));
    }
  }
}

function assertInvariants(source: MatrixCase, result: BundleAllocationResult): void {
  const { components, targetPriceMinor } = source.input;
  const effectiveMinimum = source.input.minimumUnitPayableMinor ?? DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR;
  const everyNumber = [
    result.referenceTotalMinor,
    result.discountTotalMinor,
    result.discountBps,
    ...result.components.flatMap((item) => [
      item.referenceSubtotalMinor,
      item.targetSubtotalMinor,
      item.discountAllocatedMinor,
      item.discountBps,
    ]),
    ...result.lines.flatMap((item) => [item.quantity, item.effectiveUnitPriceMinor, item.lineSubtotalMinor]),
  ];

  // 1) The whole point: the emitted lines add up to the operator's price exactly.
  expect(result.lines.reduce((total, item) => total + item.lineSubtotalMinor, 0)).toBe(targetPriceMinor);
  expect(result.components.reduce((total, item) => total + item.targetSubtotalMinor, 0)).toBe(targetPriceMinor);
  // 2) Every line satisfies the identity a quote line refines.
  for (const item of result.lines) {
    expect(item.effectiveUnitPriceMinor * item.quantity).toBe(item.lineSubtotalMinor);
    expect(item.quantity).toBeGreaterThanOrEqual(1);
  }
  // 3) Nothing is invented or dropped: quantities and reference money are conserved.
  expect(result.referenceTotalMinor).toBe(source.referenceTotal);
  expect(result.discountTotalMinor).toBe(source.referenceTotal - targetPriceMinor);
  expect(result.components.reduce((total, item) => total + item.discountAllocatedMinor, 0))
    .toBe(result.discountTotalMinor);
  expect(result.components.map((item) => item.sku)).toEqual(components.map((item) => item.sku));

  for (const item of components) {
    const lines = result.lines.filter((line) => line.sku === item.sku);
    const allocation = result.components.find((entry) => entry.sku === item.sku)!;
    const floorUnit = Math.min(effectiveMinimum, item.unitPriceMinor);

    expect(lines.length).toBe(allocation.hasSplitPricing ? 2 : 1);
    expect(lines.reduce((total, line) => total + line.quantity, 0)).toBe(item.quantity);
    expect(lines.reduce((total, line) => total + line.lineSubtotalMinor, 0)).toBe(allocation.targetSubtotalMinor);
    // 4) The floor and the reference price bound every emitted unit price. A component
    // whose reference price is below the floor is held to its reference price, because
    // no floor may lift a component above what it is worth.
    for (const line of lines) {
      expect(line.effectiveUnitPriceMinor).toBeGreaterThanOrEqual(floorUnit);
      expect(line.effectiveUnitPriceMinor).toBeLessThanOrEqual(item.unitPriceMinor);
    }
    expect(allocation.referenceSubtotalMinor).toBe(item.unitPriceMinor * item.quantity);
    expect(allocation.discountAllocatedMinor)
      .toBe(allocation.referenceSubtotalMinor - allocation.targetSubtotalMinor);
    expect(allocation.discountAllocatedMinor).toBeGreaterThanOrEqual(0);
  }
  // 5) Everything that leaves the kernel is a safe integer.
  for (const value of everyNumber) expect(Number.isSafeInteger(value)).toBe(true);
}

describe("bundle target-price allocation", () => {
  it("holds every allocation invariant across the generated matrix", () => {
    let allocated = 0;
    let refused = 0;

    for (const source of matrix) {
      const result = allocateBundleTargetPrice(source.input);
      // Same input twice is identical output — no clock, no order dependence.
      expect(allocateBundleTargetPrice(source.input)).toEqual(result);

      if (!result.ok) {
        refused += 1;
        const expected = source.referenceTotal === 0
          ? "REFERENCE_TOTAL_ZERO"
          : source.input.targetPriceMinor > source.referenceTotal
            ? "TARGET_ABOVE_COMPONENT_SUM"
            : "TARGET_BELOW_FLOOR";
        expect({ label: source.label, code: result.code }).toEqual({ label: source.label, code: expected });
        continue;
      }

      allocated += 1;
      expect(source.referenceTotal).toBeGreaterThan(0);
      expect(source.input.targetPriceMinor).toBeGreaterThanOrEqual(source.floorTotal);
      assertInvariants(source, result);
    }

    // The matrix must actually exercise both outcomes rather than silently refusing.
    expect(matrix.length).toBe(1_440);
    expect(allocated).toBeGreaterThan(1_000);
    expect(refused).toBeGreaterThan(0);
  });

  it("prices a component that divides evenly as one line", () => {
    expect(allocateBundleTargetPrice({
      components: [{ sku: "UNIT-A", unitPriceMinor: 1_000, quantity: 4 }],
      targetPriceMinor: 3_600,
    })).toEqual({
      ok: true,
      referenceTotalMinor: 4_000,
      targetPriceMinor: 3_600,
      discountTotalMinor: 400,
      discountBps: 1_000,
      floorApplied: false,
      components: [{
        sku: "UNIT-A",
        quantity: 4,
        referenceUnitPriceMinor: 1_000,
        referenceSubtotalMinor: 4_000,
        targetSubtotalMinor: 3_600,
        discountAllocatedMinor: 400,
        discountBps: 1_000,
        hasSplitPricing: false,
      }],
      lines: [{ sku: "UNIT-A", quantity: 4, effectiveUnitPriceMinor: 900, lineSubtotalMinor: 3_600 }],
    });
  });

  it("emits two lines when the allocated subtotal does not divide by the quantity", () => {
    const result = allocateBundleTargetPrice({
      components: [{ sku: "UNIT-A", unitPriceMinor: 1_000, quantity: 3 }],
      targetPriceMinor: 2_500,
    });

    expect(result).toMatchObject({
      ok: true,
      components: [{ targetSubtotalMinor: 2_500, hasSplitPricing: true }],
      lines: [
        { sku: "UNIT-A", quantity: 1, effectiveUnitPriceMinor: 834, lineSubtotalMinor: 834 },
        { sku: "UNIT-A", quantity: 2, effectiveUnitPriceMinor: 833, lineSubtotalMinor: 1_666 },
      ],
    });
  });

  it("breaks a remainder tie by component code, not by input order", () => {
    const first = allocateBundleTargetPrice({
      components: [
        { sku: "UNIT-A", unitPriceMinor: 3, quantity: 1 },
        { sku: "UNIT-B", unitPriceMinor: 3, quantity: 1 },
      ],
      targetPriceMinor: 5,
    });
    const reversed = allocateBundleTargetPrice({
      components: [
        { sku: "UNIT-B", unitPriceMinor: 3, quantity: 1 },
        { sku: "UNIT-A", unitPriceMinor: 3, quantity: 1 },
      ],
      targetPriceMinor: 5,
    });

    expect(first).toMatchObject({ ok: true, lines: [
      { sku: "UNIT-A", effectiveUnitPriceMinor: 3 },
      { sku: "UNIT-B", effectiveUnitPriceMinor: 2 },
    ] });
    // Order-independent: the extra minor unit follows the code, not the array slot.
    expect(reversed).toMatchObject({ ok: true, lines: [
      { sku: "UNIT-B", effectiveUnitPriceMinor: 2 },
      { sku: "UNIT-A", effectiveUnitPriceMinor: 3 },
    ] });
  });

  it("lifts a component whose proportional share fell under its floor", () => {
    const result = allocateBundleTargetPrice({
      components: [
        { sku: "UNIT-A", unitPriceMinor: 1_000, quantity: 1 },
        { sku: "UNIT-B", unitPriceMinor: 2, quantity: 1 },
      ],
      targetPriceMinor: 100,
    });

    expect(result).toMatchObject({
      ok: true,
      floorApplied: true,
      components: [
        { sku: "UNIT-A", targetSubtotalMinor: 99 },
        { sku: "UNIT-B", targetSubtotalMinor: 1 },
      ],
    });
    expect(result.ok && result.lines.reduce((total, line) => total + line.lineSubtotalMinor, 0)).toBe(100);
  });

  it("keeps a zero-priced component free and reports no discount rate for it", () => {
    expect(allocateBundleTargetPrice({
      components: [
        { sku: "UNIT-A", unitPriceMinor: 100, quantity: 1 },
        { sku: "UNIT-B", unitPriceMinor: 0, quantity: 2 },
      ],
      targetPriceMinor: 80,
    })).toMatchObject({
      ok: true,
      floorApplied: false,
      components: [
        { sku: "UNIT-A", targetSubtotalMinor: 80, discountBps: 2_000 },
        { sku: "UNIT-B", targetSubtotalMinor: 0, discountAllocatedMinor: 0, discountBps: 0 },
      ],
      lines: [
        { sku: "UNIT-A", quantity: 1, effectiveUnitPriceMinor: 80 },
        { sku: "UNIT-B", quantity: 2, effectiveUnitPriceMinor: 0 },
      ],
    });
  });

  it("rounds the reported discount rate half up", () => {
    expect(allocateBundleTargetPrice({
      components: [{ sku: "UNIT-A", unitPriceMinor: 20_000, quantity: 1 }],
      targetPriceMinor: 19_999,
    })).toMatchObject({ ok: true, discountBps: 1, components: [{ discountBps: 1 }] });
  });

  it("refuses a composition with nothing to weigh against", () => {
    expect(allocateBundleTargetPrice({
      components: [{ sku: "UNIT-A", unitPriceMinor: 0, quantity: 3 }],
      targetPriceMinor: 0,
    })).toEqual({ ok: false, code: "REFERENCE_TOTAL_ZERO" });
  });

  it("refuses a bundle priced above the sum of its parts", () => {
    expect(allocateBundleTargetPrice({
      components: [{ sku: "UNIT-A", unitPriceMinor: 50, quantity: 2 }],
      targetPriceMinor: 101,
    })).toEqual({ ok: false, code: "TARGET_ABOVE_COMPONENT_SUM" });
  });

  it("refuses a target that cannot cover every component's minimum payable", () => {
    expect(allocateBundleTargetPrice({
      components: [
        { sku: "UNIT-A", unitPriceMinor: 10, quantity: 2 },
        { sku: "UNIT-B", unitPriceMinor: 10, quantity: 2 },
      ],
      targetPriceMinor: 19,
      minimumUnitPayableMinor: 5,
    })).toEqual({ ok: false, code: "TARGET_BELOW_FLOOR" });
  });

  it("applies a minimum payable of one minor unit unless the caller says otherwise", () => {
    const components = [{ sku: "UNIT-A", unitPriceMinor: 10, quantity: 2 }];

    expect(allocateBundleTargetPrice({ components, targetPriceMinor: 1 }))
      .toEqual({ ok: false, code: "TARGET_BELOW_FLOOR" });
    expect(allocateBundleTargetPrice({ components, targetPriceMinor: 1, minimumUnitPayableMinor: 0 }))
      .toMatchObject({ ok: true, components: [{ targetSubtotalMinor: 1, hasSplitPricing: true }] });
  });

  it("rejects a malformed request rather than pricing it", () => {
    const valid = { sku: "UNIT-A", unitPriceMinor: 10, quantity: 1 };
    const reject = (input: AllocateBundleTargetPriceInput) =>
      expect(() => allocateBundleTargetPrice(input)).toThrow(RangeError);

    reject({ components: [], targetPriceMinor: 1 });
    reject({ components: undefined as unknown as BundleComponentInput[], targetPriceMinor: 1 });
    reject({ components: [{ ...valid, sku: "  " }], targetPriceMinor: 1 });
    reject({ components: [{ ...valid, sku: 7 as unknown as string }], targetPriceMinor: 1 });
    reject({ components: [valid, { ...valid, unitPriceMinor: 20 }], targetPriceMinor: 1 });
    reject({ components: [{ ...valid, quantity: 0 }], targetPriceMinor: 1 });
    reject({ components: [{ ...valid, quantity: 1.5 }], targetPriceMinor: 1 });
    reject({ components: [{ ...valid, unitPriceMinor: -1 }], targetPriceMinor: 1 });
    reject({ components: [valid], targetPriceMinor: -1 });
    reject({ components: [valid], targetPriceMinor: 1.5 });
    reject({ components: [valid], targetPriceMinor: 1, minimumUnitPayableMinor: -1 });
    reject({
      components: [{ sku: "UNIT-A", unitPriceMinor: Number.MAX_SAFE_INTEGER, quantity: 2 }],
      targetPriceMinor: 1,
    });
  });

  it("keeps the failure vocabulary and the default floor stable", () => {
    expect(BUNDLE_ALLOCATION_FAILURE_CODES).toEqual([
      "REFERENCE_TOTAL_ZERO",
      "TARGET_ABOVE_COMPONENT_SUM",
      "TARGET_BELOW_FLOOR",
    ]);
    expect(DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR).toBe(1);
  });
});
