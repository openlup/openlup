import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  calculateCatalogueMoneyV2, CatalogueMoneyV2Error, planCatalogueMoneyV2,
  type CatalogueMoneyV2ErrorCode, type CatalogueMoneyV2Input, type CatalogueMoneyV2Tax,
} from "@openlup/core/pricing";

const max = Number.MAX_SAFE_INTEGER;
const source = (lineKey: string, sourceOrdinal: number, unitBasisMinor: number) =>
  ({ lineKey, sourceOrdinal, unitBasisMinor, quantity: 1 });
const line = (lineKey: string, sourceOrdinal: number) => ({ kind: "merchandise" as const, lineKey, sourceOrdinal });
const item = line("item", 1);
const input = (fields: Partial<CatalogueMoneyV2Input> = {}): CatalogueMoneyV2Input =>
  ({ amountBasis: "inclusive", sources: [], delivery: [], adjustments: [], fees: [], ...fields });
const adjustment = (sequence: number, amountMinor: number, ...lineKeys: string[]) =>
  ({ adjustmentRef: "discount", sequence, amountMinor, target: { lineKeys } });
const inclusive = (rateBps = 0): CatalogueMoneyV2Tax => ({ kind: "inclusive", components: [{ ref: item, rateBps }] });
const local = (...rateDecimals: string[]): CatalogueMoneyV2Tax => ({
  kind: "local", components: [{ ref: item, rates: rateDecimals.map((rateDecimal, index) =>
    ({ positionRef: `position-${index}`, jurisdictionRef: "district-a", rateDecimal })) }],
});

function refuses(run: () => unknown, code: CatalogueMoneyV2ErrorCode, field: string, remedy?: string): void {
  expect(run).toThrow(CatalogueMoneyV2Error);
  expect(run).toThrow(expect.objectContaining(remedy === undefined ? { code, field } : { code, field, remedy }));
}

function permutations(values: readonly number[]): number[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, other) => other !== index)).map(tail => [value, ...tail]));
}

function weightLists(size: number): number[][] {
  if (size === 0) return [[]];
  return weightLists(size - 1).flatMap(tail => [0, 1, 2, 3, 4].map(weight => [...tail, weight]));
}

// Here all operands are small integers. Rank each remainder by counting the entries ahead of it.
function quotaOracle(weights: readonly number[], discount: number, total: number): number[] {
  if (total === 0) return weights.map(() => 0);
  const numerators = weights.map(weight => discount * weight);
  const floors = numerators.map(quota => Math.floor(quota / total));
  const remaining = discount - floors.reduce((sum, floor) => sum + floor, 0);
  const remainders = numerators.map(quota => quota % total);
  return floors.map((floor, index) => {
    const ahead = remainders.filter((remainder, other) =>
      remainder > remainders[index] || (remainder === remainders[index] && other < index)).length;
    return floor + Number(ahead < remaining);
  });
}

describe("catalogue money v2 planning", () => {
  it.each([1, 2, 3, 4])("apportions every small discount over %i sources independently of input order", count => {
    const indexes = Array.from({ length: count }, (_, index) => index);
    const orders = permutations(indexes);
    for (const weights of weightLists(count)) {
      const sources = weights.map((amount, index) => source(`line-${index}`, index + 1, amount));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      for (let amount = 0; amount <= total; amount++) {
        const expected = quotaOracle(weights, amount, total);
        for (const order of orders) {
          const shuffled = order.map(index => sources[index]);
          const plan = planCatalogueMoneyV2(input({
            sources: shuffled, adjustments: [adjustment(1, amount, ...shuffled.map(row => row.lineKey))],
          }));
          const shares = plan.components.map((component, index) => {
            assert.equal(component.ref.sourceOrdinal, index + 1);
            const share = component.allocations[0]?.basisReductionMinor ?? 0;
            assert(share >= 0 && share <= weights[index]);
            assert.equal(component.effectiveMinor, weights[index] - share);
            assert.equal(component.allocations.length, Number(share > 0));
            return share;
          });
          assert.equal(shares.reduce((sum, share) => sum + share, 0), amount);
          assert.deepEqual(shares, expected);
        }
      }
    }
  });

  it("applies successive discounts to remaining eligible balances and retains sequence gaps", () => {
    const plan = planCatalogueMoneyV2(input({
      sources: [source("a", 1, 8), source("b", 2, 4), source("c", 3, 2)],
      adjustments: [adjustment(2, 4, "a"), adjustment(4, 3, "c", "a"), adjustment(7, 3, "b", "c"), adjustment(9, 0, "a")],
    }));
    expect(plan.components.map(({ effectiveMinor, allocations }) => ({
      effectiveMinor, steps: allocations.map(({ sequence, beforeMinor, afterMinor }) => [sequence, beforeMinor, afterMinor]),
    }))).toEqual([
      { effectiveMinor: 2, steps: [[2, 8, 4], [4, 4, 2]] },
      { effectiveMinor: 2, steps: [[7, 4, 2]] },
      { effectiveMinor: 0, steps: [[4, 2, 1], [7, 1, 0]] },
    ]);
  });

  it("derives shipping from final merchandise even when shipping is larger than those weights", () => {
    const quote = input({
      sources: [source("a", 4, 3), source("b", 2, 2)],
      delivery: [
        { bucketKey: "pack", deliveryKind: "handling", amountMinor: 5 },
        { bucketKey: "ship", deliveryKind: "shipping", amountMinor: 20 },
      ],
      adjustments: [
        { adjustmentRef: "delivery", sequence: 1, amountMinor: 3, target: { bucketKey: "ship" } },
        adjustment(3, 1, "a"),
        { adjustmentRef: "handling", sequence: 8, amountMinor: 1, target: { bucketKey: "pack" } },
      ],
    });
    const tax = { kind: "inclusive", components: [
      { ref: line("a", 4), rateBps: 0 },
      { ref: { kind: "delivery", bucketKey: "pack" }, rateBps: 10_000 },
      { ref: line("b", 2), rateBps: 10_000 },
    ] } as const;
    const result = calculateCatalogueMoneyV2(quote, tax);
    expect(result.components.map(({ ref, initial, final }) =>
      [ref, initial.amountMinor, final.amountMinor, final.taxMinor])).toEqual([
      [line("b", 2), 2, 2, 1],
      [line("a", 4), 3, 2, 0],
      [{ kind: "delivery", bucketKey: "pack" }, 5, 4, 2],
      [{ kind: "delivery", bucketKey: "ship", sourceOrdinal: 2 }, 10, 8, 4],
      [{ kind: "delivery", bucketKey: "ship", sourceOrdinal: 4 }, 10, 9, 0],
    ]);
  });

  it("retains zero shipping shares for positive weights and leaves exclusive buckets unsplit", () => {
    const quote = input({
      sources: [source("a", 2, 2), source("b", 1, 2), source("c", 3, 0)],
      delivery: [{ bucketKey: "ship", deliveryKind: "shipping", amountMinor: 1 }],
    });
    expect(planCatalogueMoneyV2(quote).components.slice(3)).toEqual([
      { ref: { kind: "delivery", bucketKey: "ship", sourceOrdinal: 1 }, preDiscountMinor: 1, effectiveMinor: 1, allocations: [] },
      { ref: { kind: "delivery", bucketKey: "ship", sourceOrdinal: 2 }, preDiscountMinor: 0, effectiveMinor: 0, allocations: [] },
    ]);
    expect(planCatalogueMoneyV2({ ...quote, amountBasis: "exclusive", delivery: [
      ...quote.delivery, { bucketKey: "extra", deliveryKind: "shipping", amountMinor: 2 },
    ] }).components.slice(3).map(component => component.ref)).toEqual([
      { kind: "delivery", bucketKey: "ship" }, { kind: "delivery", bucketKey: "extra" },
    ]);
  });

  it("allows aggregate weights above the safe integer range and a later zero payable", () => {
    const quote = input({
      sources: [source("item", 1, max), source("second", 2, max)],
      adjustments: [adjustment(1, max, "item", "second"), adjustment(4, max - 1, "item", "second")],
    });
    const tax = { kind: "inclusive", components: [
      { ref: item, rateBps: 0 }, { ref: line("second", 2), rateBps: 0 },
    ] } as const;
    const result = calculateCatalogueMoneyV2(quote, tax);
    expect(result.components[0].allocations[0].basisReductionMinor).toBe(4503599627370496);
    expect(result.payableMinor).toBe(1);
    expect(calculateCatalogueMoneyV2({
      ...quote, adjustments: [...quote.adjustments, adjustment(5, 1, "item", "second")],
    }, tax).payableMinor).toBe(0);
  });
});

describe("catalogue money v2 tax evidence", () => {
  const quote = input({ amountBasis: "exclusive", sources: [source("item", 1, 10)],
    adjustments: [adjustment(2, 0, "item"), adjustment(5, 1, "item"), adjustment(9, 2, "item")] });
  const position = (taxMinor: number) => ({ positionRef: "position", jurisdictionRef: "district-a",
    rateDecimal: "0.005000", taxableMinor: 10, taxMinor });
  const states = [
    { afterSequence: 0, amountMinor: 10, taxPositions: [position(3)] },
    { afterSequence: 5, amountMinor: 9, taxPositions: [position(2)] },
    { afterSequence: 9, amountMinor: 7, taxPositions: [position(2)] },
  ];
  const provider = (evidence = states, payableMinor = 9): CatalogueMoneyV2Tax =>
    ({ kind: "provider", payableMinor, components: [{ ref: item, states: evidence }] });

  it("matches only nonzero adjustment steps and returns fresh records", () => {
    const fees = [{ feeKey: "second", amountMinor: 2 }, { feeKey: "first", amountMinor: 1 }];
    const paid = calculateCatalogueMoneyV2({ ...quote, fees }, provider(states, 12));
    expect(paid.payableMinor).toBe(12);
    expect(paid.components[0].allocations.map(row =>
      [row.sequence, row.before.amountMinor, row.after.amountMinor, row.netReductionMinor, row.taxReductionMinor]))
      .toEqual([[5, 10, 9, 1, 1], [9, 9, 7, 2, 0]]);
    expect(paid.components[0].ref).not.toBe(item);
    expect(paid.components[0].initial.taxPositions[0]).not.toBe(states[0].taxPositions[0]);
    expect(paid.fees).toEqual(fees);
    expect(paid.fees[0]).not.toBe(fees[0]);
    expect(calculateCatalogueMoneyV2(input({ amountBasis: "exclusive" }),
      { kind: "provider", payableMinor: 0, components: [] }).payableMinor).toBe(0);
  });

  it.each([
    ["missing state", provider(states.slice(0, 2)), "money_tax_evidence_mismatch", "tax.components[0].states",
      "Provider evidence has missing states. Supply 3 states with an initial state and one per nonzero allocation."],
    ["extra state", provider([...states, states[2]]), "money_tax_evidence_mismatch", "tax.components[0].states",
      "Provider evidence has extra states. Supply 3 states with an initial state and one per nonzero allocation."],
    ["misordered state", provider([states[0], states[2], states[1]]),
      "money_tax_evidence_mismatch", "tax.components[0].states[1].afterSequence",
      "Provider state sequence does not match the plan. Supply states in plan order with afterSequence 5 at this step."],
    ["stale sequence", provider([states[0], { ...states[1], afterSequence: 2 }, states[2]]),
      "money_tax_evidence_mismatch", "tax.components[0].states[1].afterSequence",
      "Provider state sequence does not match the plan. Supply states in plan order with afterSequence 5 at this step."],
    ["stale amount", provider([states[0], { ...states[1], amountMinor: 8 }, states[2]]),
      "money_tax_evidence_mismatch", "tax.components[0].states[1].amountMinor",
      "Provider state amount does not match the plan. Re-obtain the provider state for amountMinor 9 at this step."],
    ["increasing tax", provider([states[0], { ...states[1], taxPositions: [position(4)] }, states[2]]),
      "money_tax_evidence_mismatch", "tax.components[0].states[1].taxPositions",
      "Provider tax increased on a discount step. Re-obtain tax positions for the plan amounts before and after that allocation."],
    ["missing component", { kind: "provider", payableMinor: 9, components: [] }, "money_tax_evidence_mismatch", "tax.components",
      "Tax evidence is missing a component row. Supply evidence for each missing component ref from the plan."],
    ["unmatched component", { kind: "provider", payableMinor: 9, components: [{ ref: line("other", 1), states }] },
      "money_tax_evidence_mismatch", "tax.components[0].ref",
      "This tax component ref does not match a required plan component. Use the matching component ref from the plan or remove the extra row."],
    ["duplicate component", { kind: "provider", payableMinor: 9, components: [{ ref: item, states }, { ref: item, states }] },
      "money_tax_evidence_mismatch", "tax.components[1].ref",
      "This tax component ref duplicates an earlier row. Supply one row for each required component ref."],
    ["different payable", provider(states, 10), "money_payable_mismatch", "tax.payableMinor",
      "Provider payable does not match the final net, tax and fees. Re-obtain the provider payable for the same plan, including fees."],
  ] as const)("refuses %s", (_name, tax, code, field, remedy) => {
    refuses(() => calculateCatalogueMoneyV2(quote, tax), code, field, remedy);
  });

  it("assigns local residuals by raw quota remainder and rounds every state once", () => {
    const result = calculateCatalogueMoneyV2(quote, local("4", "9", "4"));
    const { initial, allocations, final } = result.components[0];
    expect(initial.taxPositions.map(row => row.taxMinor)).toEqual([1, 1, 0]);
    expect(allocations.map(row => row.taxReductionMinor)).toEqual([0, 1]);
    expect(final.taxPositions.map(row => row.taxMinor)).toEqual([0, 1, 0]);
    expect(final.totalMinor).toBe(8);
  });

  it.each(["", "00", "-1", "+1", "1.", ".5", "1e2", "1.1234567", "1\n", "9007199254.740992", "10000000000"])(
    "rejects decimal percent %j in local and provider evidence", rateDecimal => {
      refuses(() => calculateCatalogueMoneyV2(quote, local(rateDecimal)), "money_rate_invalid", "tax.components[0].rates[0].rateDecimal");
      const initial = { ...states[0], taxPositions: [{ ...position(3), rateDecimal }] };
      refuses(() => calculateCatalogueMoneyV2(quote, provider([initial, ...states.slice(1)])), "money_rate_invalid",
        "tax.components[0].states[0].taxPositions[0].rateDecimal");
    },
  );

  it("accepts the exact rate bound, six decimal places and a rate of zero", () => {
    const small = input({ amountBasis: "exclusive", sources: [source("item", 1, 1)] });
    const result = calculateCatalogueMoneyV2(small, local("9007199254.740991", "0.000001", "0"));
    expect(result.components[0].final.taxPositions.map(row => row.taxMinor)).toEqual([90071993, 0, 0]);
  });

  it.each([-1, 0.5, 10001, NaN, Infinity])("rejects inclusive basis points %s", rateBps => {
    refuses(() => calculateCatalogueMoneyV2(input({ sources: [source("item", 1, 1)] }), inclusive(rateBps)),
      "money_rate_invalid", "tax.components[0].rateBps", "Supply an integer from 0 to 10000 basis points.");
  });
});

describe("catalogue money v2 input and arithmetic limits", () => {
  it.each([
    ["negative amount", input({ sources: [source("item", 1, -1)] }), "money_amount_out_of_range", "sources[0].unitBasisMinor"],
    ["ordinal", input({ sources: [source("item", 0, 1)] }), "money_amount_out_of_range", "sources[0].sourceOrdinal"],
    ["quantity", input({ sources: [{ ...source("item", 1, 1), quantity: 1.5 }] }), "money_amount_out_of_range", "sources[0].quantity"],
    ["zero quantity", input({ sources: [{ ...source("item", 1, 1), quantity: 0 }] }),
      "money_amount_out_of_range", "sources[0].quantity", "Supply a safe integer of at least 1."],
    ["blank ref", input({ sources: [source("", 1, 1)] }), "money_input_invalid", "sources[0].lineKey"],
    ["oversized ref", input({ sources: [source("a".repeat(129), 1, 1)] }), "money_input_invalid", "sources[0].lineKey"],
    ["sparse sources", input({ sources: Array<never>(1) }), "money_input_invalid", "sources[0]"],
    ["oversized sources", input({ sources: Array.from({ length: 257 }, (_, i) => source(String(i), i + 1, 1)) }),
      "money_input_invalid", "sources", "Supply at most 256 entries."],
    ["second shipping charge", input({ delivery: [
      { bucketKey: "a", deliveryKind: "shipping", amountMinor: 0 }, { bucketKey: "b", deliveryKind: "shipping", amountMinor: 0 },
    ] }), "money_input_invalid", "delivery[1].deliveryKind",
      "Use at most one shipping bucket for inclusive amounts. Combine shipping charges into that bucket."],
    ["sequence regression", input({ adjustments: [adjustment(2, 0), adjustment(1, 0)] }), "money_input_invalid", "adjustments[1].sequence"],
    ["unresolved line", input({ adjustments: [adjustment(1, 0, "missing")] }), "money_input_invalid", "adjustments[0].target.lineKeys[0]"],
    ["duplicate target", input({ sources: [source("item", 1, 1)], adjustments: [adjustment(1, 0, "item", "item")] }),
      "money_input_invalid", "adjustments[0].target.lineKeys[1]"],
    ["per-source basis field", input({ sources: [{ ...source("item", 1, 1), amountBasis: "inclusive" } as CatalogueMoneyV2Input["sources"][number]] }),
      "money_input_invalid", "sources[0]"],
    ["duplicate fee", input({ fees: [{ feeKey: "fee", amountMinor: 0 }, { feeKey: "fee", amountMinor: 0 }] }),
      "money_input_invalid", "fees[1].feeKey"],
  ] as const)("refuses %s", (_name, quote, code, field, remedy?: string) => {
    refuses(() => planCatalogueMoneyV2(quote), code, field, remedy);
  });

  it("range-checks component state and aggregate values before conversion", () => {
    const exclusive = input({ amountBasis: "exclusive", sources: [source("item", 1, max)] });
    refuses(() => calculateCatalogueMoneyV2(exclusive, local("1")), "money_amount_out_of_range", "tax.components[0].totalMinor");
    refuses(() => calculateCatalogueMoneyV2(exclusive, local("1000")), "money_amount_out_of_range", "tax.components[0].taxMinor");
    const quote = input({ sources: exclusive.sources, fees: [{ feeKey: "fee", amountMinor: 1 }] });
    refuses(() => calculateCatalogueMoneyV2(quote, inclusive()), "money_amount_out_of_range", "payableMinor");
    refuses(() => calculateCatalogueMoneyV2({ ...quote, sources: [...quote.sources, source("second", 2, 1)] },
      { kind: "inclusive", components: [{ ref: item, rateBps: 0 }, { ref: line("second", 2), rateBps: 0 }] }),
    "money_amount_out_of_range", "netTotal");
  });
});
