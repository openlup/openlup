import { readFileSync } from "node:fs";
import { calculateCatalogueMoneyV2 } from "@openlup/core/pricing";
import type { CatalogueMoneyV2ComponentRef } from "@openlup/core/pricing";
import type { PromotionRow } from "@openlup/core/promo";
import { describe, expect, it } from "vitest";
import { composeCommerceQuoteMoneyV2, planCommerceQuoteMoneyV2 } from "../../src/pricing/index.js";
import type { CommerceQuoteMoneyV2Plan, ComposeCommerceQuoteMoneyV2Input, PlanCommerceQuoteMoneyV2Input,
  QuoteShippingPromotionResult } from "../../src/pricing/index.js";
import { createQuotePromotionCodeAdjustments, createQuoteShippingPromotions } from "../../src/promotions/index.js";
import type { PromotionCodeQuotePort, ResolvedPromotionCodeCandidate } from "../../src/promotions/index.js";
import { AT, orchestrators, port, pricingPolicy, request, row } from "../promotions/parityFixtures.js";
import { bucket, facts, fee, id, localEvidence, metadata, moneyGolden, price, source } from "./quoteMoneyV2Fixtures.js";

type Candidate = NonNullable<PlanCommerceQuoteMoneyV2Input["selected"]>;
type Adjustment = Candidate["adjustments"][number];
type FiscalInput = Extract<ComposeCommerceQuoteMoneyV2Input, { fiscal: unknown }>;

const baseline = { amountBasis: "inclusive", deliverySelectionRef: "delivery:one", delivery: [], feeLines: [] } as const;
function planInput(changes: Partial<PlanCommerceQuoteMoneyV2Input> = {}): PlanCommerceQuoteMoneyV2Input {
  return { currency: "XXX", listBasis: null, engine: "promotion-engine.v1", price, lines: [source("a", 1, 100)], baseline, ...changes };
}
function adjustment(adjustmentRef: string, amountOffMinor: number, target: Adjustment["target"],
  appliesTo: Adjustment["appliesTo"] = "order_total"): Adjustment {
  return { adjustmentRef, amountOffMinor, target, appliesTo, evidenceRef: "promotion:α" };
}
function planned(input: PlanCommerceQuoteMoneyV2Input): CommerceQuoteMoneyV2Plan {
  const result = planCommerceQuoteMoneyV2(input);
  if (result.kind !== "planned") throw new Error(JSON.stringify(result));
  return result;
}
function ids({ plan }: CommerceQuoteMoneyV2Plan) {
  let next = 3;
  return plan.components.flatMap(({ ref, allocations }) => allocations.map(({ sequence }) => ({ ref, sequence, allocationId: id(next++) })));
}
function componentLabel(ref: CatalogueMoneyV2ComponentRef): string {
  if (ref.kind === "merchandise") return ref.lineKey;
  return ref.bucketKey + (ref.sourceOrdinal === undefined ? "" : "-" + ref.sourceOrdinal);
}
function fiscalInput(plan: CommerceQuoteMoneyV2Plan, rates: Readonly<Record<string, number>> = {}, quoteFacts = facts): FiscalInput {
  const shipping = plan.winner.delivery.find(item => item.kind === "shipping")?.bucketKey;
  const fiscal = plan.plan.components.flatMap(({ ref }) => ref.kind === "delivery" && ref.bucketKey === shipping
    ? [] : [{ ref, rateBps: rates[componentLabel(ref)] ?? 0 }]);
  const positions = plan.plan.components.flatMap(({ ref, preDiscountMinor }) => preDiscountMinor === 0
    ? [] : [{ ref, position: metadata("position-" + componentLabel(ref)) }]);
  return { planned: plan, facts: quoteFacts, fiscal, positions, taxEvidence: localEvidence, allocationIds: ids(plan) };
}
function composed(input: ComposeCommerceQuoteMoneyV2Input) {
  const result = composeCommerceQuoteMoneyV2(input);
  if (result.kind !== "composed") throw new Error(JSON.stringify(result));
  return result;
}

type Vector = {
  name: string;
  input: {
    sources: { lineKey: string; sourceOrdinal: string; quantity: string; unitBasisMinor: string }[];
    delivery: { deliveryKind: "shipping" | "handling"; amountMinor: string }[];
    adjustments: { adjustmentRef: string; amountMinor: string; target: Adjustment["target"] }[];
  };
  tax: { components: { ref: CatalogueMoneyV2ComponentRef; rateBps: string }[] };
  expected: { netTotal: string; taxTotal: string; payableMinor: string };
};
const vectorPath = new URL("../../../core/test/fixtures/catalogue-money.v2.json", import.meta.url);
const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as { rows: { id: string; cases: Vector[] }[] };
function readVector(key: string) {
  const { input, tax, expected } = vectors.rows.find(entry => entry.id === key)!.cases[0];
  const lines = input.sources.map(value => source(value.lineKey, Number(value.sourceOrdinal), Number(value.unitBasisMinor), Number(value.quantity)));
  const delivery = input.delivery.map(value => bucket(value.deliveryKind, Number(value.amountMinor)));
  const adjustments = input.adjustments.map(({ adjustmentRef, amountMinor, target }) => adjustment(adjustmentRef, Number(amountMinor),
    "bucketKey" in target ? { bucketKey: "shipping" } : target, "bucketKey" in target ? "shipping" : "order_total"));
  const rates = Object.fromEntries(tax.components.map(({ rateBps, ref }) => [componentLabel(ref), Number(rateBps)]));
  const plain = { ...baseline, delivery };
  return { input: planInput({ lines, baseline: plain, selected: { ...plain, adjustments } }), rates, expected };
}

describe("offline quote money v2", () => {
  it("one_cent_tie_source_ordinal with reversed sources and duplicate SKUs", () => {
    const { input, rates } = readVector("one_cent_tie_source_ordinal");
    const reversed = { ...input, lines: [...input.lines].reverse() };
    const first = composed(fiscalInput(planned(input), rates));
    expect(first.money).toStrictEqual(moneyGolden());
    expect(first.money.lines.map(line => [line.lineKey, line.sku])).toEqual([["z", "article:ż"], ["a", "article:ż"]]);
    const [share] = first.money.lines[0].discountAllocations;
    expect(share).toMatchObject({ netReductionMinor: 0, taxReductionMinor: 1,
      before: { basisMinor: 3, netMinor: 2, taxMinor: 1 }, after: { basisMinor: 2, netMinor: 2, taxMinor: 0 } });
    expect(first.money).toMatchObject({ netTotal: 5, taxTotal: 0, payableMinor: 5 });
    expect(composed(fiscalInput(planned(reversed), rates))).toStrictEqual(first);
  });

  it("stitches mixed-rate merchandise and shipping states from the shared vector", () => {
    const { input, rates, expected } = readVector("mixed_tax_discount_shipping_golden");
    const compose = fiscalInput(planned(input), rates);
    const { money } = composed(compose);
    expect(money).toMatchObject({ netTotal: Number(expected.netTotal), taxTotal: Number(expected.taxTotal),
      payableMinor: Number(expected.payableMinor) });
    expect(money.deliveryBuckets[0].parts.map(part => [part.sourceOrdinal, part.preDiscountMinor, part.effectiveMinor,
      part.taxPositions[0].rateDecimal, part.discountAllocations[0].sequence])).toEqual([[1, 47, 42, "8", 2], [2, 53, 48, "23", 2]]);
    expect(money.deliveryBuckets[0].parts[0].taxPositions[0].positionRef).not.toBe(money.lines[0].taxPositions[0].positionRef);
    expect(composeCommerceQuoteMoneyV2({ ...compose, positions: compose.positions.slice(1) })).toMatchObject({
      kind: "refused", code: "money_tax_evidence_mismatch", field: "/positions",
    });
    expect(composeCommerceQuoteMoneyV2({ ...compose, allocationIds: compose.allocationIds.slice(1) })).toMatchObject({
      kind: "refused", code: "promotion_allocation_unsubstantiated", field: "/allocationIds",
    });
  });

  it("refuses positive shipping with zero merchandise weight", () => {
    const { input } = readVector("zero_weight_shipping");
    expect(planCommerceQuoteMoneyV2(input)).toMatchObject({ kind: "refused", code: "shipping_tax_basis_empty", field: "/deliveryBuckets" });
  });

  it("uses inclusive fees and exclusive handling when comparing complete candidates", () => {
    const original = { ...baseline, delivery: [bucket("shipping", 0), bucket("handling", 4)], feeLines: [fee("fee", 8)] };
    const selected = { ...original, deliverySelectionRef: "delivery:two",
      delivery: [bucket("shipping", 0), bucket("handling", 12)], feeLines: [], adjustments: [adjustment("product", 1, { lineKeys: ["a"] })] };
    const gross = planned(planInput({ baseline: original, selected }));
    expect(gross.promotion.rankingRuleRef).toBe("lowest_payable_gross");
    expect(gross.winner.deliverySelectionRef).toBe("delivery:two");
    const net = planned(planInput({ listBasis: "exclusive", lines: [source("a", 1, 100, 1, "net")],
      baseline: { ...original, amountBasis: "exclusive", feeLines: [] }, selected: { ...selected, amountBasis: "exclusive" } }));
    expect(net.promotion.rankingRuleRef).toBe("lowest_pre_tax.v1");
    expect(net.winner.deliverySelectionRef).toBe("delivery:one");
    const tie = planned(planInput({ baseline: original, selected: { ...selected, delivery: [bucket("shipping", 0), bucket("handling", 13)] } }));
    expect(tie.winner.deliverySelectionRef).toBe("delivery:two");
  });

  it("projects request-bound exclusive states and overlapping positions, and joins fees exactly once", () => {
    const original = { ...baseline, amountBasis: "exclusive", delivery: [bucket("shipping", 0)] } as const;
    const plan = planned(planInput({ listBasis: "exclusive", baseline: original,
      lines: [source("a", 1, 20, 1, "net"), source("z", 2, 100, 1, "net")],
      selected: { ...original, adjustments: [
        adjustment("first", 2, { lineKeys: ["a"] }, "line"), adjustment("second", 10, { lineKeys: ["z"] }),
      ] } }));
    expect(plan.plan.fees).toEqual([]);
    expect(plan.moneyInput.fees).toEqual([]);
    const fees = [fee("later", 2), fee("earlier", 1)];
    const zState = (amountMinor: number, afterSequence: number) => ({
      amountMinor, afterSequence, taxPositions: ["district-a", "district-b"].map(jurisdictionRef => ({
        positionRef: "position-" + jurisdictionRef, jurisdictionRef, taxableMinor: amountMinor, taxMinor: amountMinor / 10, rateDecimal: "10",
      })),
    });
    const verifiedMoney = calculateCatalogueMoneyV2({ ...plan.moneyInput, fees: fees.map(({ feeKey, amountMinor }) => ({ feeKey, amountMinor })) },
      { kind: "provider", payableMinor: 129, components: plan.plan.components.map(({ ref }) => {
        const states = ref.kind === "merchandise" && ref.lineKey === "z" ? [zState(100, 0), zState(90, 2)]
          : ref.kind === "merchandise" ? [{ amountMinor: 20, afterSequence: 0, taxPositions: [] },
            { amountMinor: 18, afterSequence: 1, taxPositions: [] }]
            : [{ amountMinor: 0, afterSequence: 0, taxPositions: [] }];
        return { ref, states };
      }) });
    const input = { planned: plan, facts, allocationIds: ids(plan), taxEvidence: { ...localEvidence, kind: "tax_calculation" as const },
      verifiedMoney, positions: ["district-b", "district-a"].map(jurisdiction => metadata("position-" + jurisdiction, jurisdiction)),
      feeLines: [...fees].reverse() };
    const { money } = composed(input);
    expect(money).toMatchObject({ netTotal: 108, taxTotal: 18, feeTotal: 3, payableMinor: 129 });
    expect(money.feeLines).toEqual(fees);
    expect(money.deliveryBuckets[0].parts).toMatchObject([{ effectiveMinor: 0, taxPositions: [] }]);
    expect(money.lines[1].taxPositions.map(position => position.taxableMinor)).toEqual([90, 90]);
    expect(money.lines[1].discountAllocations).toMatchObject([{ sequence: 2, before: { basisMinor: 100, netMinor: 100, taxMinor: 20 },
      after: { basisMinor: 90, netMinor: 90, taxMinor: 18 }, taxReductionMinor: 2 }]);
    expect(composeCommerceQuoteMoneyV2({ ...input, feeLines: fees.slice(1) })).toMatchObject({
      kind: "refused", code: "money_tax_evidence_mismatch", field: "/feeLines",
    });
    expect(composeCommerceQuoteMoneyV2({ ...input, verifiedMoney: { ...verifiedMoney, netTotal: 109 } })).toMatchObject({
      kind: "refused", code: "money_tax_evidence_mismatch", field: "/verifiedMoney",
    });
    expect(composeCommerceQuoteMoneyV2({ ...input, positions: input.positions.slice(1) })).toMatchObject({
      kind: "refused", code: "money_tax_evidence_mismatch", field: "/positions",
    });
  });

  it.each([10_000, 2_147_483_647])("checks the exact payable limit %i with a fee on free shipping", limit => {
    const run = (feeAmount: number) => {
      const plan = planned(planInput({ lines: [source("a", 1, limit - 1)],
        baseline: { ...baseline, delivery: [{ ...bucket("shipping", 0), threshold: { flatMinor: 200, freeThresholdMinor: limit - 1 } }],
          feeLines: [fee("fee", feeAmount)] } }));
      return composeCommerceQuoteMoneyV2(fiscalInput(plan, {}, { ...facts, paymentLimits: { ...facts.paymentLimits, maxMinor: limit } }));
    };
    expect(run(1)).toMatchObject({ kind: "composed", money: { feeTotal: 1, payableMinor: limit,
      deliveryBuckets: [{ parts: [{ taxPositions: [], effectiveMinor: 0 }] }],
      feeLines: [{ feeKey: "fee", amountMinor: 1 }] } });
    expect(run(2)).toEqual({ kind: "refused", code: "money_amount_out_of_range", field: "/payableMinor",
      remedy: "Choose a supported amount and obtain a fresh quote." });
  });

  it("refuses mixed basis, unsupported targets and an unreconciled threshold", () => {
    expect(planCommerceQuoteMoneyV2(planInput({ lines: [source("a", 1, 10, 1, "net")] }))).toMatchObject({
      kind: "refused", code: "money_amount_basis_mixed", field: "/amountBasis",
    });
    expect(planCommerceQuoteMoneyV2(planInput({ selected: { ...baseline,
      adjustments: [adjustment("bad", 1, { lineKeys: ["missing"] })] } }))).toMatchObject({
      kind: "refused", code: "promotion_allocation_unsubstantiated", field: "/adjustments/0/target/lineKeys/0",
    });
    expect(planCommerceQuoteMoneyV2(planInput({ baseline: { ...baseline, delivery: [{
      ...bucket("shipping", 1), threshold: { flatMinor: 1, freeThresholdMinor: 100 },
    }] } }))).toMatchObject({ kind: "refused", code: "money_input_invalid", field: "/deliveryBuckets/0/amountMinor" });
  });
});

const engines = {
  v1: { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v1" },
  v2: pricingPolicy,
} as const;
function resolvedCode(code: string, promotionId: string, valueMinor: number): ResolvedPromotionCodeCandidate {
  return { promotionId, code, codeId: promotionId, source: "code", name: promotionId, lane: "product", kind: "fixed_amount",
    valueMinor, scopes: ["one_time"], codeRevision: 1, definitionFingerprint: "a".repeat(64), minimumReferenceMinor: 0, validTo: null };
}
async function owner(rows: PromotionRow[], codes: string[], engine: keyof typeof engines, subtotal: number,
  candidates: ResolvedPromotionCodeCandidate[] = []) {
  const promotionCodeQuotePort: PromotionCodeQuotePort | undefined = candidates.length ? {
    resolve: async () => ({ candidates, codeRejectionDetails: [],
      codeRejections: codes.includes("Unknown") ? [{ code: "Unknown", reason: "not_recognized" }] : [] }),
  } : undefined;
  const fixture = createQuoteShippingPromotions({
    ...orchestrators(), ...createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: 7 }),
    promoDataPort: port(rows), promotionCodeQuotePort,
    commerceSettingsPort: { getShippingSettings: async () => ({
      legacyFlatMinor: 200, policy: { version: "shipping-policy.v1", current: {
        enabled: true, flatMinor: 200, freeThresholdMinor: 1_000, effectiveFrom: AT,
      } },
    }) },
  });
  return fixture.resolveQuoteShippingPromotions({ request: { ...request, mode: "one_time", promoCodes: codes },
    options: { pricingPolicy: engines[engine] }, regionCode: "ZZ", currency: "XXX", atTime: AT,
    referenceProductMinor: subtotal, subtotalGrossMinor: subtotal });
}
function ownerPlan(result: QuoteShippingPromotionResult, engine: keyof typeof engines, subtotal: number, codes: string[]) {
  const delivery = (amount: number) => [{ ...bucket("shipping", amount), threshold: { flatMinor: 200, freeThresholdMinor: 1_000 } }];
  const adjustments = result.discounts.map(row => adjustment(row.promotionId, row.amountOffMinor,
    row.appliesTo === "shipping" ? { bucketKey: "shipping" } : { lineKeys: ["a"] }, row.appliesTo));
  return planned(planInput({ engine: engines[engine].promotionEngineVersion, lines: [source("a", 1, subtotal)],
    baseline: { ...baseline, delivery: delivery(subtotal >= 1_000 ? 0 : 200) },
    ...(adjustments.length ? { selected: { ...baseline, deliverySelectionRef: "selected", delivery: delivery(result.shippingGrossMinor), adjustments } } : {}),
    codeDiagnostics: { submittedCodes: codes, appliedCodes: result.discounts.flatMap(discount => discount.code ? [discount.code] : []),
      codeRejections: result.codeRejections, codeRejectionDetails: result.codeRejectionDetails },
  }));
}

describe("promotion owner parity with offline composition", () => {
  it("keeps v1 exclusive-first, name and stable equality ties before its independent shipping lane", async () => {
    const rows = [
      row("stacked", { name: "First", stacking_rule: "stackable", discount_type: "fixed_amount", discount_value: 300 }),
      row("z-name", { name: "Z", discount_type: "fixed_amount", discount_value: 100 }),
      row("first-a", { name: "A", discount_type: "fixed_amount", discount_value: 100 }),
      row("second-a", { name: "A", discount_type: "fixed_amount", discount_value: 100 }),
      row("free", { discount_type: "free_shipping" }),
    ];
    const result = await owner(rows, [], "v1", 900);
    expect(result.discounts.map(discount => discount.promotionId)).toEqual(["first-a", "free"]);
    const { money } = composed(fiscalInput(ownerPlan(result, "v1", 900, [])));
    expect(money.lines[0].discountAllocations).toMatchObject([{ sequence: 1, adjustmentRef: "first-a" }]);
    expect(money.deliveryBuckets[0].parts[0].discountAllocations).toMatchObject([{ sequence: 2, adjustmentRef: "free" }]);
  });

  it("keeps v2 automatic-before-code and code-unit identity ties and preserves submitted spelling", async () => {
    const automatic = (id: string) => row(id, { promotion_engine_version: "promotion-engine.v2", benefit_lane: "product",
      benefit_kind: "target_percentage", benefit_value_bps: 1_000 });
    const codes = [" sAvE ", "SAVE", "Other"];
    const candidates = [resolvedCode("SAVE", "z-code", 90), resolvedCode("Other", "a-code", 90)];
    const tiedCodes = candidates.map(({ valueMinor: _valueMinor, ...candidate }) => ({ ...candidate, kind: "target_percentage" as const, valueBps: 1_000 }));
    const result = await owner([automatic("a-winner"), automatic("Z-winner")], codes, "v2", 900, tiedCodes);
    expect(result.discounts.map(discount => discount.promotionId)).toEqual(["Z-winner"]);
    expect(result.codeRejections).toEqual([{ code: " sAvE ", reason: "better_price_exists" }, { code: "Other", reason: "better_price_exists" }]);
    const quote = composed(fiscalInput(ownerPlan(result, "v2", 900, codes)));
    expect(quote.money.lines[0].discountAllocations).toMatchObject([{ adjustmentRef: "Z-winner" }]);
    expect(quote.codeDiagnostics?.codeRejections).toEqual(result.codeRejections);

    const codeWinner = await owner([], codes, "v2", 900, candidates);
    expect(codeWinner.discounts).toMatchObject([{ promotionId: "a-code", code: "Other" }]);
    const first = await owner([], codes, "v2", 900, [candidates[0]]);
    expect(first.discounts).toMatchObject([{ promotionId: "z-code", code: " sAvE " }]);
    expect(composed(fiscalInput(ownerPlan(first, "v2", 900, codes))).money.lines[0].discountAllocations)
      .toMatchObject([{ adjustmentRef: "z-code" }]);
  });

  it("keeps exact legacy code matching before normalized fallback", async () => {
    const coupon = (promotionId: string, code: string, value: number) => row(promotionId, { code, trigger_type: "coupon_code",
      discount_type: "fixed_amount", discount_value: value });
    const code = ["SAVE"];
    const result = await owner([coupon("exact", "SAVE", 20), coupon("other", "save", 50)], code, "v1", 900);
    expect(result.discounts).toMatchObject([{ promotionId: "exact", amountOffMinor: 20 }]);
    expect(composed(fiscalInput(ownerPlan(result, "v1", 900, code))).money.lines[0].discountAllocations)
      .toMatchObject([{ adjustmentRef: "exact", basisReductionMinor: 20 }]);
  });

  it("reports a displaced code neutrally when the baseline keeps free delivery", async () => {
    const codes = [" sAvE ", "Unknown"];
    const result = await owner([], codes, "v2", 1_000, [resolvedCode("SAVE", "promo", 90)]);
    expect(result.discounts).toMatchObject([{ code: " sAvE ", amountOffMinor: 90 }]);
    expect(result.shippingGrossMinor).toBe(200);
    expect(result.codeRejections).toEqual([{ code: "Unknown", reason: "not_recognized" }]);
    const outcome = ownerPlan(result, "v2", 1_000, codes);
    expect(outcome.winner.adjustments).toEqual([]);
    const quote = composed(fiscalInput(outcome));
    expect(quote.money).toMatchObject({ payableMinor: 1_000, deliveryBuckets: [{ parts: [{ effectiveMinor: 0 }] }] });
    expect(quote.codeDiagnostics?.codeRejections).toEqual([
      { code: " sAvE ", reason: "better_price_exists" }, { code: "Unknown", reason: "not_recognized" },
    ]);
  });
});
