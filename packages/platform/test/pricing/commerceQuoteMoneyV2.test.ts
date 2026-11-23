import { readFileSync } from "node:fs";
import { calculateCatalogueMoneyV2 } from "@openlup/core/pricing";
import type { CatalogueMoneyV2ComponentRef } from "@openlup/core/pricing";
import type { PromotionRow } from "@openlup/core/promo";
import { describe, expect, it } from "vitest";
import { commerceQuoteV2Schema, composeCommerceQuoteMoneyV2, planCommerceQuoteMoneyV2 } from "../../src/pricing/index.js";
import type { CommerceQuoteMoneyV2Plan, ComposeCommerceQuoteMoneyV2Input, PlanCommerceQuoteMoneyV2Input,
  QuoteShippingPromotionResult } from "../../src/pricing/index.js";
import { createQuotePromotionCodeAdjustments, createQuoteShippingPromotions } from "../../src/promotions/index.js";
import type { PromotionCodeQuotePort, ResolvedPromotionCodeCandidate } from "../../src/promotions/index.js";
import { AT, orchestrators, port, pricingPolicy, request, row } from "../promotions/parityFixtures.js";
import { bucket, facts, fee, id, localEvidence, metadata, moneyGolden, price, sealQuote, source } from "./quoteMoneyV2Fixtures.js";

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
function fiscalInput(planInput: PlanCommerceQuoteMoneyV2Input, rates: Readonly<Record<string, number>> = {}, quoteFacts = facts): FiscalInput {
  const plan = planned(planInput);
  const shipping = plan.winner.delivery.find(item => item.kind === "shipping")?.bucketKey;
  const fiscal = plan.plan.components.flatMap(({ ref }) => ref.kind === "delivery" && ref.bucketKey === shipping
    ? [] : [{ ref, rateBps: rates[componentLabel(ref)] ?? 0 }]);
  const positions = plan.plan.components.flatMap(({ ref, preDiscountMinor }) => preDiscountMinor === 0
    ? [] : [{ ref, position: metadata("position-" + componentLabel(ref)) }]);
  return { planInput, facts: quoteFacts, fiscal, positions, taxEvidence: localEvidence, allocationIds: ids(plan) };
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
  return { input: planInput({ lines, baseline: plain, ...(adjustments.length ? { selected: { ...plain, adjustments } } : {}) }), rates, expected };
}

describe("offline quote money v2", () => {
  it("one_cent_tie_source_ordinal with reversed sources and duplicate SKUs", () => {
    const { input, rates } = readVector("one_cent_tie_source_ordinal");
    const reversed = { ...input, lines: [...input.lines].reverse() };
    const first = composed(fiscalInput(input, rates));
    expect(first.money).toStrictEqual(moneyGolden());
    expect(first.money.lines.map(line => [line.lineKey, line.sku])).toEqual([["z", "article:ż"], ["a", "article:ż"]]);
    const [share] = first.money.lines[0].discountAllocations;
    expect(share).toMatchObject({ netReductionMinor: 0, taxReductionMinor: 1,
      before: { basisMinor: 3, netMinor: 2, taxMinor: 1 }, after: { basisMinor: 2, netMinor: 2, taxMinor: 0 } });
    expect(first.money).toMatchObject({ netTotal: 5, taxTotal: 0, payableMinor: 5 });
    expect(composed(fiscalInput(reversed, rates))).toStrictEqual(first);
  });

  it("stitches mixed-rate merchandise and shipping states from the shared vector", () => {
    const { input, rates, expected } = readVector("mixed_tax_discount_shipping_golden");
    const compose = fiscalInput(input, rates);
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
      kind: "refused", code: "money_input_invalid", field: "/allocationIds",
    });
  });

  it("refuses positive shipping with zero merchandise weight", () => {
    const { input } = readVector("zero_weight_shipping");
    expect(planCommerceQuoteMoneyV2(input)).toMatchObject({ kind: "refused", code: "shipping_tax_basis_empty", field: "/baseline" });
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

  it("replans the identical exclusive request, projects overlapping positions and joins fees once", () => {
    const original = { ...baseline, amountBasis: "exclusive", delivery: [bucket("shipping", 0)] } as const;
    const planning = planInput({ listBasis: "exclusive", baseline: original,
      lines: [source("a", 1, 20, 1, "net"), source("z", 2, 100, 1, "net")],
      selected: { ...original, adjustments: [
        adjustment("first", 2, { lineKeys: ["a"] }, "line"), adjustment("second", 10, { lineKeys: ["z"] }),
      ] } });
    const plan = planned(planning);
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
    const input = { planInput: planning, facts, allocationIds: ids(plan), taxEvidence: { ...localEvidence, kind: "tax_calculation" as const },
      verifiedMoney, positions: ["district-b", "district-a"].map(jurisdiction => metadata("position-" + jurisdiction, jurisdiction)),
      feeLines: [...fees].reverse() };
    const { money } = composed(input);
    expect(money).toMatchObject({ netTotal: 108, taxTotal: 18, feeTotal: 3, payableMinor: 129 });
    expect(money.feeLines).toEqual(fees);
    expect(money.deliveryBuckets[0].parts).toMatchObject([{ effectiveMinor: 0, taxPositions: [] }]);
    expect(money.lines[1].taxPositions.map(position => position.taxableMinor)).toEqual([90, 90]);
    expect(money.lines.map(({ lineKey, sourceOrdinal, preDiscountMinor, effectiveMinor, discountAllocations }) => ({
      ref: { kind: "merchandise", lineKey, sourceOrdinal }, preDiscountMinor, effectiveMinor,
      allocations: discountAllocations.map(({ adjustmentRef, sequence, basisReductionMinor, before, after }) =>
        ({ adjustmentRef, sequence, basisReductionMinor, beforeMinor: before.basisMinor, afterMinor: after.basisMinor })),
    }))).toStrictEqual(plan.plan.components.filter(({ ref }) => ref.kind === "merchandise"));
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
    const [firstId, secondId] = input.allocationIds;
    expect(composeCommerceQuoteMoneyV2({ ...input, allocationIds: [firstId, { ...secondId, allocationId: firstId.allocationId }] }))
      .toMatchObject({ kind: "refused", code: "money_input_invalid", field: "/allocationIds/1/allocationId" });
  });

  it.each([10_000, 2_147_483_647])("checks the exact payable limit %i with a fee on free shipping", limit => {
    const run = (feeAmount: number) => {
      const planning = planInput({ lines: [source("a", 1, limit - 1)],
        baseline: { ...baseline, delivery: [{ ...bucket("shipping", 0), threshold: { flatMinor: 200, freeThresholdMinor: limit - 1 } }],
          feeLines: [fee("fee", feeAmount)] } });
      return composeCommerceQuoteMoneyV2(fiscalInput(planning, {}, { ...facts, paymentLimits: { ...facts.paymentLimits, maxMinor: limit } }));
    };
    expect(run(1)).toMatchObject({ kind: "composed", money: { feeTotal: 1, payableMinor: limit,
      deliveryBuckets: [{ parts: [{ taxPositions: [], effectiveMinor: 0 }] }],
      feeLines: [{ feeKey: "fee", amountMinor: 1 }] } });
    expect(run(2)).toEqual({ kind: "refused", code: "money_amount_out_of_range", field: "/planInput/baseline",
      remedy: "Choose a supported amount and obtain a fresh quote." });
  });

  it("refuses mixed basis, unsupported targets and an unreconciled threshold", () => {
    expect(planCommerceQuoteMoneyV2(planInput({ lines: [source("a", 1, 10, 1, "net")] }))).toMatchObject({
      kind: "refused", code: "money_amount_basis_mixed", field: "/lines/0",
    });
    expect(planCommerceQuoteMoneyV2(planInput({ selected: { ...baseline,
      adjustments: [adjustment("bad", 1, { lineKeys: ["missing"] })] } }))).toMatchObject({
      kind: "refused", code: "promotion_allocation_unsubstantiated", field: "/selected/adjustments/0",
    });
    expect(planCommerceQuoteMoneyV2(planInput({ baseline: { ...baseline, delivery: [{
      ...bucket("shipping", 1), threshold: { flatMinor: 1, freeThresholdMinor: 100 },
    }] } }))).toMatchObject({ kind: "refused", code: "money_input_invalid", field: "/baseline/delivery/0" });
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
function ownerPlan(result: QuoteShippingPromotionResult, engine: keyof typeof engines, subtotal: number) {
  const delivery = (amount: number) => [{ ...bucket("shipping", amount), threshold: { flatMinor: 200, freeThresholdMinor: 1_000 } }];
  const adjustments = result.discounts.map(row => adjustment(row.promotionId, row.amountOffMinor,
    row.appliesTo === "shipping" ? { bucketKey: "shipping" } : { lineKeys: ["a"] }, row.appliesTo));
  return planInput({ engine: engines[engine].promotionEngineVersion, lines: [source("a", 1, subtotal)],
    baseline: { ...baseline, delivery: delivery(subtotal >= 1_000 ? 0 : 200) },
    ...(adjustments.length ? { selected: { ...baseline, deliverySelectionRef: "selected", delivery: delivery(result.shippingGrossMinor), adjustments } } : {}),
    codeDiagnostics: { appliedCodes: result.discounts.flatMap(discount => discount.code ? [discount.code] : []),
      codeRejections: result.codeRejections, codeRejectionDetails: result.codeRejectionDetails },
  });
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
    const { money } = composed(fiscalInput(ownerPlan(result, "v1", 900)));
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
    const quote = composed(fiscalInput(ownerPlan(result, "v2", 900)));
    expect(quote.money.lines[0].discountAllocations).toMatchObject([{ adjustmentRef: "Z-winner" }]);
    expect(quote.codeDiagnostics?.codeRejections).toEqual(result.codeRejections);
    expect(quote).not.toHaveProperty("displacedCodes");

    const codeWinner = await owner([], codes, "v2", 900, candidates);
    expect(codeWinner.discounts).toMatchObject([{ promotionId: "a-code", code: "Other" }]);
    const first = await owner([], codes, "v2", 900, [candidates[0]]);
    expect(first.discounts).toMatchObject([{ promotionId: "z-code", code: " sAvE " }]);
    expect(composed(fiscalInput(ownerPlan(first, "v2", 900))).money.lines[0].discountAllocations)
      .toMatchObject([{ adjustmentRef: "z-code" }]);
  });

  it("keeps exact legacy code matching before normalized fallback", async () => {
    const coupon = (promotionId: string, code: string, value: number) => row(promotionId, { code, trigger_type: "coupon_code",
      discount_type: "fixed_amount", discount_value: value });
    const code = ["SAVE"];
    const result = await owner([coupon("exact", "SAVE", 20), coupon("other", "save", 50)], code, "v1", 900);
    expect(result.discounts).toMatchObject([{ promotionId: "exact", amountOffMinor: 20 }]);
    expect(composed(fiscalInput(ownerPlan(result, "v1", 900))).money.lines[0].discountAllocations)
      .toMatchObject([{ adjustmentRef: "exact", basisReductionMinor: 20 }]);
  });

  it.each([
    { engine: "v1", codes: ["save", "Unknown", "SAVE"], collision: true },
    { engine: "v1", codes: [" sAvE ", "Unknown"], collision: false },
    { engine: "v2", codes: [" sAvE ", "Unknown"], collision: false },
  ] as const)("returns the $engine owner's literal applied values separately from its diagnostics", async ({ engine, codes, collision }) => {
    const coupon = row("promo", { code: "SAVE", trigger_type: "coupon_code", discount_type: "fixed_amount", discount_value: 90 });
    const rows = collision ? [row("lower", { ...coupon, id: "lower", code: "save", discount_value: 10 }), coupon] : [coupon];
    const result = await owner(rows, [...codes], engine, 1_000);
    expect(result.discounts).toMatchObject([{ code: "SAVE", amountOffMinor: 90 }]);
    expect(result.shippingGrossMinor).toBe(200);
    expect(result.codeRejections).toContainEqual({ code: "Unknown", reason: "not_recognized" });
    const planning = ownerPlan(result, engine, 1_000);
    const outcome = composed(fiscalInput(planning));
    expect(outcome.money).toMatchObject({ payableMinor: 1_000, deliveryBuckets: [{ parts: [{ effectiveMinor: 0 }] }] });
    expect(outcome.displacedCodes).toStrictEqual([{ code: "SAVE", reason: "better_price_exists" }]);
    expect(JSON.stringify(outcome.codeDiagnostics?.codeRejections)).toBe(JSON.stringify(result.codeRejections));
    expect(JSON.stringify(outcome.codeDiagnostics?.codeRejectionDetails)).toBe(JSON.stringify(result.codeRejectionDetails));
  });

  it("keeps displacement duplicates in owner order and passes both diagnostic arrays through byte for byte", () => {
    const codeRejections = [{ reason: "not_eligible", code: "   Not eligible " }] as const;
    const codeRejectionDetails = [{ reason: "global_limit_reached", code: "   Not eligible " }] as const;
    const appliedCodes = ["Z", " sAvE ", "SAVE", " sAvE "];
    const planning = planInput({
      selected: { ...baseline, delivery: [bucket("handling", 3)], adjustments: [adjustment("promotion", 1, { lineKeys: ["a"] })] },
      codeDiagnostics: { appliedCodes, codeRejections, codeRejectionDetails },
    });
    for (const outcome of [planned(planning), composed(fiscalInput(planning))]) {
      expect(JSON.stringify(outcome.codeDiagnostics?.codeRejections)).toBe(JSON.stringify(codeRejections));
      expect(JSON.stringify(outcome.codeDiagnostics?.codeRejectionDetails)).toBe(JSON.stringify(codeRejectionDetails));
      expect(outcome.displacedCodes).toStrictEqual(appliedCodes.map(code => ({ code, reason: "better_price_exists" })));
    }
  });
});

function pointerParent(original: unknown, field: string) {
  const keys = field.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let parent: unknown = original;
  for (const key of keys.slice(0, -1)) {
    expect(parent).not.toBeNull();
    expect(typeof parent).toBe("object");
    expect(Object.hasOwn(parent as object, key)).toBe(true);
    parent = Object.getOwnPropertyDescriptor(parent, key)?.value;
  }
  expect(parent).not.toBeNull();
  expect(typeof parent).toBe("object");
  return { parent: parent as object, key: keys.at(-1)! };
}

describe("caller-relative quote money refusals", () => {
  const plan = (input: unknown) => planCommerceQuoteMoneyV2(input as PlanCommerceQuoteMoneyV2Input);
  const compose = (input: unknown) => composeCommerceQuoteMoneyV2(input as ComposeCommerceQuoteMoneyV2Input);
  const quote = (input: unknown) => {
    const parsed = commerceQuoteV2Schema.safeParse(input);
    if (parsed.success) return parsed;
    const issue = parsed.error.issues[0];
    return issue.code === "custom" ? issue.params : issue;
  };

  const selected = { ...baseline, adjustments: [adjustment("promotion", 1, { lineKeys: ["a"] })] };
  const composeWithFee = () => fiscalInput(planInput({
    baseline: { ...baseline, delivery: [bucket("shipping", 0)], feeLines: [fee("fee-on-free-delivery", 2)] },
  }));
  const foreign = { ...bucket("shipping", 0), cost: { ...bucket("shipping", 0).cost, currency: "ALT" } };
  const exclusive = { ...baseline, amountBasis: "exclusive", delivery: [bucket("shipping", 0)] } as const;
  const netInput = { listBasis: "exclusive", lines: [source("a", 1, 100, 1, "net")] } as const;

  it.each([
    { name: "non-object plan", run: plan, make: () => null, field: "" },
    { name: "missing currency", run: plan, make: () => ({}), field: "/currency", missing: true },
    { name: "missing baseline delivery", run: plan, make: () => {
      const { delivery: _delivery, ...incomplete } = baseline;
      return planInput({ baseline: incomplete as typeof baseline });
    }, field: "/baseline/delivery", missing: true },
    { name: "malformed baseline", run: plan, make: () => ({ ...planInput(), baseline: null }), field: "/baseline" },
    { name: "engine", run: plan, make: () => ({ ...planInput(), engine: "invalid" }), field: "/engine" },
    { name: "list basis", run: plan, make: () => ({ ...planInput(), listBasis: "invalid" }), field: "/listBasis" },
    { name: "baseline threshold", run: plan, make: () => planInput({ baseline: { ...baseline, delivery: [{
      ...bucket("shipping", 1), threshold: { flatMinor: 1, freeThresholdMinor: 100 },
    }] } }), field: "/baseline/delivery/0" },
    { name: "selected target", run: plan, make: () => planInput({ selected: {
      ...selected, adjustments: [adjustment("bad", 1, { lineKeys: ["missing"] })],
    } }), field: "/selected/adjustments/0" },
    { name: "baseline currency", run: plan, make: () => planInput({ baseline: { ...baseline, delivery: [foreign] } }),
      field: "/baseline/delivery/0" },
    { name: "selected currency", run: plan, make: () => planInput({ selected: { ...selected, delivery: [foreign] } }),
      field: "/selected/delivery/0" },
    { name: "exclusive baseline fee", run: plan, make: () => planInput({ ...netInput, baseline: {
      ...exclusive, feeLines: [fee("baseline", 1)],
    } }), field: "/baseline/feeLines" },
    { name: "exclusive selected fee", run: plan, make: () => planInput({ ...netInput, baseline: exclusive, selected: {
      ...exclusive, adjustments: selected.adjustments, feeLines: [fee("selected", 1)],
    } }), field: "/selected/feeLines" },
    { name: "nonexistent baseline bucket would inflate a cheaper baseline above 105", run: plan,
      make: () => planInput({ baseline: { ...baseline, feeLines: [fee("orphan", 10)] },
        selected: { ...selected, delivery: [bucket("handling", 6)] } }), field: "/baseline/feeLines/0" },
    { name: "nonexistent selected bucket", run: plan, make: () => planInput({
      selected: { ...selected, feeLines: [fee("orphan", 1)] },
    }), field: "/selected/feeLines/0" },
    { name: "explicit undefined candidate", run: plan, make: () => ({ ...planInput(), selected: undefined }), field: "/selected" },
    { name: "non-object composition", run: compose, make: () => 42, field: "" },
    { name: "missing planning input", run: compose, make: () => ({}), field: "/planInput", missing: true },
    { name: "missing planning lines", run: compose, make: () => {
      const valid = composeWithFee();
      const { lines: _lines, ...planInput } = valid.planInput;
      return { ...valid, planInput };
    }, field: "/planInput/lines", missing: true },
    { name: "malformed planning quantity", run: compose, make: () => {
      const valid = composeWithFee();
      return { ...valid, planInput: { ...valid.planInput, lines: [{ ...valid.planInput.lines[0], quantity: 0 }] } };
    }, field: "/planInput/lines/0/quantity" },
    { name: "nonpayable winning baseline", run: compose, make: () => fiscalInput(planInput({ lines: [source("a", 1, 0)] })),
      field: "/planInput/baseline" },
    { name: "nonpayable winning selected candidate", run: compose, make: () => fiscalInput(planInput({
      selected: { ...baseline, adjustments: [adjustment("waiver", 100, { lineKeys: ["a"] })] },
    })), field: "/planInput/selected" },
    { name: "missing projected facts", run: compose, make: () => ({ ...composeWithFee(), facts: {} }),
      field: "/facts/mode", missing: true },
    { name: "explicit undefined cadence", run: compose, make: () => ({
      ...composeWithFee(), facts: { ...facts, cadence: undefined },
    }), field: "/facts/cadence" },
    { name: "explicit undefined position provider line", run: compose, make: () => {
      const composeInput = composeWithFee();
      const [row] = composeInput.positions;
      return { ...composeInput, positions: [{ ...row, position: { ...row.position, providerLineRef: undefined } }] };
    }, field: "/positions/0/position/providerLineRef" },
    { name: "explicit undefined fee provider position", run: compose, make: () => {
      const composeInput = composeWithFee();
      const { planInput } = composeInput;
      return { ...composeInput, planInput: { ...planInput, baseline: {
        ...planInput.baseline, feeLines: [{ ...planInput.baseline.feeLines[0], providerPositionRef: undefined }],
      } } };
    }, field: "/planInput/baseline/feeLines/0/providerPositionRef" },
    { name: "explicit undefined provider fee position on the exclusive arm", run: compose, make: () => {
      const planning = planInput({ ...netInput, baseline: exclusive });
      const plannedMoney = planned(planning);
      const feeLine = fee("fee-on-free-delivery", 2);
      const verifiedMoney = calculateCatalogueMoneyV2({ ...plannedMoney.moneyInput, fees: [{ feeKey: feeLine.feeKey, amountMinor: 2 }] },
        { kind: "local", components: plannedMoney.plan.components.map(({ ref }) => ({ ref, rates: [] })) });
      return { planInput: planning, facts, allocationIds: [], positions: [], verifiedMoney,
        taxEvidence: { ...localEvidence, kind: "tax_calculation" }, feeLines: [{ ...feeLine, providerPositionRef: undefined }] };
    }, field: "/feeLines/0/providerPositionRef" },
    { name: "unavailable fiscal rates", run: compose, make: () => ({ ...composeWithFee(), fiscal: [] }), field: "/fiscal" },
    { name: "composed negative fiscal rate", run: compose, make: () => {
      const composeInput = composeWithFee();
      return { ...composeInput, fiscal: [{ ...composeInput.fiscal[0], rateBps: -1 }] };
    }, field: "/fiscal/0/rateBps" },
    { name: "non-object quote", run: quote, make: () => undefined, field: "" },
    { name: "missing quote discriminator", run: quote, make: () => ({}), field: "/amountBasis", missing: true },
    { name: "missing quote evidence digest", run: quote, make: () => {
      const valid = moneyGolden();
      const { evidenceDigest: _digest, ...taxEvidence } = valid.taxEvidence;
      return sealQuote({ ...valid, taxEvidence } as typeof valid);
    }, field: "/taxEvidence/evidenceDigest", missing: true },
    { name: "explicit undefined quote cadence", run: quote, make: () => ({ ...sealQuote(), cadence: undefined }), field: "/cadence" },
    { name: "explicit undefined quote position provider line", run: quote, make: () => {
      const valid = sealQuote();
      const [first, ...rest] = valid.lines;
      return { ...valid, lines: [{ ...first, taxPositions: [{ ...first.taxPositions[0], providerLineRef: undefined }] }, ...rest] };
    }, field: "/lines/0/taxPositions/0/providerLineRef" },
    { name: "explicit undefined quote fee provider position", run: quote, make: () => {
      const money = composed(composeWithFee()).money;
      return { ...sealQuote(money), feeLines: [{ ...money.feeLines[0], providerPositionRef: undefined }] };
    }, field: "/feeLines/0/providerPositionRef" },
    { name: "escaped quote key", run: quote, make: () => ({ ...sealQuote(), "a~/b": undefined }), field: "/a~0~1b" },
    { name: "digest mismatch", run: quote, make: () => ({ ...sealQuote(), payableMinor: -1 }), field: "/moneyDigest" },
  ])("$name names the present value or missing required key", ({ run, make, field, missing }) => {
    const original = make();
    expect(run(original)).toMatchObject({ field, code: expect.any(String), remedy: expect.any(String) });
    if (!field) {
      expect(original == null || typeof original !== "object" || Array.isArray(original)).toBe(true);
      return;
    }
    const { parent, key } = pointerParent(original, field);
    expect(Object.hasOwn(parent, key)).toBe(!missing);
  });

  const entries = [
    { name: "plan", run: plan, make: planInput, child: "baseline", field: "/baseline" },
    { name: "compose", run: compose, make: composeWithFee, child: "planInput", field: "/planInput" },
    { name: "quote", run: quote, make: sealQuote, child: "destination", field: "/destination" },
  ] as const;
  const trap = () => { throw new Error("must stay inside admission"); };
  const accessor = { get defect() { throw new Error("getter must not be invoked"); } };
  const deep = (links: number, leaf: unknown) => Array.from({ length: links }).reduce<unknown>(value => ({ defect: value }), leaf);
  const cases = [
    { name: "revoked root proxy", nested: false, make: (value: object) => {
      const { proxy, revoke } = Proxy.revocable(value, {});
      revoke();
      return proxy;
    }, suffix: "" },
    { name: "root array hole", nested: false, make: () => Array(2), suffix: "" },
    { name: "root symbol key", nested: false, make: (value: object) => ({ ...value, [Symbol()]: 1 }), suffix: "" },
    { name: "throwing root reflection", nested: false, make: (value: object) => new Proxy(value, { ownKeys: trap }), suffix: "" },
    { name: "throwing nested reflection", nested: true, make: (value: object) => new Proxy(value, { getPrototypeOf: trap }), suffix: "" },
    { name: "accessor", nested: true, make: (value: object) => Object.defineProperties({ ...value }, Object.getOwnPropertyDescriptors(accessor)), suffix: "/defect" },
    { name: "hidden own key", nested: true, make: (value: object) => Object.defineProperty({ ...value }, "defect", { value: 1 }), suffix: "/defect" },
    { name: "symbol own key", nested: true, make: (value: object) => ({ ...value, [Symbol("defect")]: 1 }), suffix: "" },
    { name: "escaped own-member key", nested: true, make: (value: object) => Object.defineProperty({ ...value }, "defect~/", { value: 1 }), suffix: "/defect~0~1" },
    { name: "array hole", nested: true, make: (value: object) => ({ ...value, defect: Array(2) }), suffix: "/defect" },
    { name: "array extra own key", nested: true, make: (value: object) => ({ ...value, defect: Object.assign([1], { extra: 1 }) }), suffix: "/defect" },
    { name: "hidden array index", nested: true, make: (value: object) => ({ ...value, defect: Object.defineProperty([1], "0", { enumerable: false }) }), suffix: "/defect/0" },
    { name: "cycle", nested: true, make: (value: object) => {
      const linked = { ...value, defect: value };
      linked.defect = linked;
      return linked;
    }, suffix: "/defect" },
    { name: "NUL string", nested: true, make: (value: object) => ({ ...value, defect: "a\u0000b" }), suffix: "/defect" },
    { name: "NUL key", nested: true, make: (value: object) => ({ ...value, "a\u0000b": 1 }), suffix: "/a\u0000b" },
    { name: "LC6 UTF-8 byte limit", nested: true, make: (value: object) => ({ ...value, defect: "λ".repeat(524_288) }), suffix: "/defect" },
    { name: "LC6 depth limit", nested: true, make: (value: object) => ({ ...value, defect: deep(46, true) }), suffix: "/defect".repeat(47) },
    { name: "LC6 depth limit for array length", nested: true, make: (value: object) => ({ ...value, defect: deep(45, []) }), suffix: "/defect".repeat(46) },
    { name: "non-plain prototype", nested: true, make: (value: object) => Object.assign(Object.create({ custom: true }), value) as object, suffix: "" },
    { name: "explicit undefined", nested: true, make: (value: object) => ({ ...value, defect: undefined }), suffix: "/defect" },
    { name: "infinite number", nested: true, make: (value: object) => ({ ...value, defect: Infinity }), suffix: "/defect" },
    { name: "NaN", nested: true, make: (value: object) => ({ ...value, defect: NaN }), suffix: "/defect" },
  ] as const;
  it.each(entries.flatMap(entry => cases.map(test => ({ entry, test }))))(
    "$entry.name refuses $test.name at its caller-relative pointer",
    ({ entry, test }) => {
      const original = entry.make();
      const input = test.nested ? { ...original, [entry.child]: test.make(Object.getOwnPropertyDescriptor(original, entry.child)!.value) }
        : test.make(original);
      const field = test.nested ? entry.field + test.suffix : "";
      expect(entry.run(input)).toMatchObject({ code: "money_input_invalid", field, remedy: "Supply plain JSON data at this field." });
      if (field) {
        const { parent, key } = pointerParent(input, field);
        expect(Object.getOwnPropertyDescriptor(parent, key)).toBeDefined();
      }
    },
  );
  it.each(entries)("$name reads each descriptor once without proxy property access", entry => {
    let calls = 0;
    const original = entry.make();
    const handler: ProxyHandler<object> = {
      get: trap,
      getOwnPropertyDescriptor(target, key) {
        if (key === Object.keys(target)[0]) calls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    };
    const input = entry.name === "compose"
      ? { ...original, planInput: new Proxy(Object.getOwnPropertyDescriptor(original, "planInput")!.value as object, handler) }
      : new Proxy(original, handler);
    const success = { plan: { kind: "planned" }, compose: { kind: "composed" }, quote: { success: true } };
    expect(entry.run(input)).toMatchObject(success[entry.name]);
    expect(calls).toBe(1);
  });
  it.each(entries)("$name keeps a descriptor capture when the same proxy occurs at two paths", entry => {
    let reads = 0;
    const child = new Proxy({ observed: 1 }, {
      get: trap,
      getOwnPropertyDescriptor(target, key) {
        if (++reads > 1) trap();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const input = { ...entry.make(), first: child, second: child };
    const expected = {
      plan: { kind: "refused", field: "/first" }, compose: { kind: "refused", field: "/first" },
      quote: { code: "money_tax_evidence_mismatch" },
    };
    expect(entry.run(input)).toMatchObject(expected[entry.name]);
    expect(reads).toBe(1);
  });

  it.each(entries)("$name admits a dense array and reads its intrinsic length exactly once", entry => {
    const input = entry.make() as unknown as { lines: unknown[]; planInput?: { lines: unknown[] } };
    const holder = input.planInput ?? input;
    const reads: string[] = [];
    const expectedKeys = [...Object.keys(holder.lines), "length"].sort();
    holder.lines = new Proxy([...holder.lines], {
      get: trap,
      getOwnPropertyDescriptor(target, key) {
        reads.push(String(key));
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const expected = { plan: { kind: "planned" }, compose: { kind: "composed" }, quote: { success: true } };
    expect(entry.run(input)).toMatchObject(expected[entry.name]);
    expect(reads.sort()).toEqual(expectedKeys);
  });
});

const removeMember = Symbol("removeMember");
const refusalCases = [
  { finding: "R3A-1", arm: "inclusive", path: "/verifiedMoney", value: { payableMinor: 1 },
    mutation: "Add verifiedMoney with payableMinor 1 to the fiscal input",
    code: "money_input_invalid", pointer: "/verifiedMoney", remedy: "Supply the documented value at this field.",
    action: "Remove verifiedMoney and keep the fiscal arm." },
  { finding: "R3A-1", arm: "exclusive", path: "/fiscal", value: [],
    mutation: "Add an empty fiscal array to the exclusive input",
    code: "money_input_invalid", pointer: "/fiscal", remedy: "Supply the documented value at this field.",
    action: "Remove fiscal and keep the verified tax arm." },
  { finding: "R3A-2", arm: "exclusive", path: "/planInput/lines/0/quantity", value: 2, recalculate: true,
    mutation: "Change quantity from 1 to 2 without refreshing verifiedMoney",
    code: "money_tax_evidence_mismatch", pointer: "/verifiedMoney", remedy: "Recalculate tax for this exact planning input, then compose again.",
    action: "Keep quantity 2 and recalculate verifiedMoney for the revised plan." },
  { finding: "R4A-1", arm: "exclusive", path: "/verifiedMoney/components/1/initial/taxPositions", recalculate: true,
    value: [{ positionRef: "free-shipping", jurisdictionRef: "district-a", rateDecimal: "10", taxableMinor: 0, taxMinor: 0 }],
    mutation: "Add a position only to the verified zero-charge shipping state",
    code: "money_tax_evidence_mismatch", pointer: "/verifiedMoney", remedy: "Recalculate tax for this exact planning input, then compose again.",
    action: "recalculate verifiedMoney without the zero-charge shipping position" },
  { finding: "R4A-1", arm: "exclusiveWaived", path: "/verifiedMoney/components/1/allocations/0/after/taxPositions", recalculate: true,
    value: [{ positionRef: "waived-shipping", jurisdictionRef: "district-a", taxableMinor: 0, taxMinor: 0 }],
    mutation: "Add a position only to the verified shipping state after a full waiver",
    code: "money_tax_evidence_mismatch", pointer: "/verifiedMoney", remedy: "Recalculate tax for this exact planning input, then compose again.",
    action: "recalculate verifiedMoney without the zero-charge shipping position" },
  { finding: "R3A-3", arm: "inclusive", path: "/planInput/selected/adjustments/0/target/lineKeys", value: removeMember,
    mutation: "Remove lineKeys from the order_total target",
    code: "money_input_invalid", pointer: "/planInput/selected/adjustments/0/target/lineKeys",
    remedy: "Supply the documented value at this field.", action: "Restore the required lineKeys array with the existing line key." },
  { finding: "R3A-3", arm: "inclusive", path: "/planInput/selected/adjustments/0/target/lineKeys/0", value: null,
    mutation: "Replace the first order_total target line key with null",
    code: "money_input_invalid", pointer: "/planInput/selected/adjustments/0/target/lineKeys/0",
    remedy: "Supply the documented value at this field.", action: "Restore the existing line key in the target array." },
  { finding: "R3A-4", arm: "inclusive", path: "/planInput/baseline/delivery/1/amountMinor", value: Number.MAX_SAFE_INTEGER,
    mutation: "Set the winning baseline handling charge to Number.MAX_SAFE_INTEGER with a maximum-safe payment limit",
    code: "money_amount_out_of_range", pointer: "/planInput/baseline", remedy: "Choose a supported amount and obtain a fresh quote.",
    action: "Restore a supported handling charge without changing the payment limit." },
  { finding: "R3A-5", arm: "exclusive", path: "/verifiedMoney/fees/1/feeKey", appendAt: "/verifiedMoney/fees/1", value: { feeKey: "service-fee", amountMinor: 2 },
    mutation: "Append a duplicate verified fee with feeKey service-fee",
    code: "money_input_invalid", pointer: "/verifiedMoney/fees/1/feeKey", remedy: "Supply the documented value at this field.",
    action: "Remove the second verified fee and preserve the fee metadata." },
  { finding: "R3A-5", arm: "inclusive", path: "/positions/1/position/positionRef", value: "position-a",
    mutation: "Reuse the merchandise positionRef on the shipping position",
    code: "money_input_invalid", pointer: "/positions/1/position/positionRef", remedy: "Supply the documented value at this field.",
    action: "Restore the distinct shipping positionRef." },
  { finding: "basis", arm: "inclusive", path: "/planInput/lines/0/amountKind", value: "net",
    mutation: "Mark an inclusive line as net",
    code: "money_amount_basis_mixed", pointer: "/planInput/lines/0", remedy: "Supply a line priced on the published list basis.",
    action: "Restore the gross line from the inclusive list." },
  { finding: "shipping", arm: "inclusive", path: "/planInput/selected/adjustments/0/amountOffMinor", value: 100,
    mutation: "Discount all merchandise while the selected shipping charge is positive",
    code: "shipping_tax_basis_empty", pointer: "/planInput/selected", remedy: "Select a supported delivery pricing policy.",
    repair: { path: "/planInput/selected/delivery/0/amountMinor", value: 0 },
    action: "Keep the waiver and choose zero-charge shipping for that candidate." },
  { finding: "allocation", arm: "inclusive", path: "/planInput/selected/adjustments/0/target/lineKeys/0", value: "missing",
    mutation: "Target a merchandise line absent from the planning input",
    code: "promotion_allocation_unsubstantiated", pointer: "/planInput/selected/adjustments/0",
    remedy: "Obtain a quote using a supported promotion combination.", action: "Restore the adjustment target to the existing merchandise line." },
  { finding: "cadence", arm: "inclusive", path: "/facts/cadence", value: { schemaVersion: 1, kind: "fixed_days", days: 7 },
    mutation: "Add cadence to one-time quote facts",
    code: "money_input_invalid", pointer: "/facts/cadence", remedy: "Supply the documented value at this field.",
    action: "Remove cadence from the one-time quote facts." },
  { finding: "expiry", arm: "exclusive", path: "/taxEvidence/expiresAt", value: localEvidence.taxDate,
    mutation: "Set the tax evidence expiry equal to its tax date",
    code: "money_tax_evidence_mismatch", pointer: "/taxEvidence", remedy: "Supply tax evidence with an expiry after its tax date.",
    action: "Restore an expiry after the tax date." },
] as const;

describe("composition refusal cases", () => {
  const inclusive = fiscalInput(planInput({
    baseline: { ...baseline, delivery: [bucket("shipping", 1), bucket("handling", 1)], feeLines: [fee("baseline-fee", 2)] },
    selected: { ...baseline, delivery: [bucket("shipping", 1), bucket("handling", Number.MAX_SAFE_INTEGER)],
      feeLines: [fee("selected-fee", 10)], adjustments: [adjustment("promotion", 1, { lineKeys: ["a"] })] },
  }), {}, { ...facts, paymentLimits: { ...facts.paymentLimits, maxMinor: Number.MAX_SAFE_INTEGER } });
  const exclusivePlan = planInput({ listBasis: "exclusive", lines: [source("a", 1, 100, 1, "net")],
    baseline: { ...baseline, amountBasis: "exclusive", delivery: [bucket("shipping", 0)] } });
  const feeLines = [{ ...fee("service-fee", 2), scope: { kind: "order" as const } }];
  const exclusiveMoney = (planning: PlanCommerceQuoteMoneyV2Input) => {
    const plan = planned(planning);
    return calculateCatalogueMoneyV2({ ...plan.moneyInput, fees: feeLines.map(({ feeKey, amountMinor }) => ({ feeKey, amountMinor })) },
      { kind: "local", components: plan.plan.components.map(({ ref }) => ({ ref, rates: [] })) });
  };
  const exclusive = { planInput: exclusivePlan, facts, allocationIds: [], positions: [], feeLines,
    taxEvidence: { ...localEvidence, kind: "tax_calculation" as const }, verifiedMoney: exclusiveMoney(exclusivePlan) };
  const shipping = { ...baseline, amountBasis: "exclusive" as const, delivery: [bucket("shipping", 10)] };
  const waivedPlan = planInput({ listBasis: "exclusive", lines: exclusivePlan.lines, baseline: shipping,
    selected: { ...shipping, adjustments: [adjustment("waiver", 10, { bucketKey: "shipping" }, "shipping")] } });
  const shippingPosition = metadata("charged-shipping");
  const waivedMoney = (planning: PlanCommerceQuoteMoneyV2Input) => {
    const plan = planned(planning);
    return calculateCatalogueMoneyV2(plan.moneyInput, {
      kind: "provider", payableMinor: 100,
      components: plan.plan.components.map(({ ref }) => ({
        ref, states: ref.kind === "delivery" ? [
          { afterSequence: 0, amountMinor: 10, taxPositions: [{ positionRef: shippingPosition.positionRef,
            jurisdictionRef: shippingPosition.jurisdictionRef, taxableMinor: 10, taxMinor: 1 }] },
          { afterSequence: 1, amountMinor: 0, taxPositions: [] },
        ] : [{ afterSequence: 0, amountMinor: 100, taxPositions: [] }],
      })),
    });
  };
  const exclusiveWaived = { ...exclusive, planInput: waivedPlan, allocationIds: ids(planned(waivedPlan)),
    feeLines: [], positions: [shippingPosition], verifiedMoney: waivedMoney(waivedPlan) };
  const fixtures = { inclusive, exclusive, exclusiveWaived };

  it.each(refusalCases)("$finding $mutation", row => {
    const original = fixtures[row.arm];
    expect(composeCommerceQuoteMoneyV2(original).kind).toBe("composed");
    const input = structuredClone(original);
    const { parent, key } = pointerParent(input, "appendAt" in row ? row.appendAt : row.path);
    const previous = Object.getOwnPropertyDescriptor(parent, key);
    if (row.value === removeMember) Reflect.deleteProperty(parent, key);
    else Object.defineProperty(parent, key, { value: row.value, enumerable: true, writable: true, configurable: true });
    expect(composeCommerceQuoteMoneyV2(input)).toEqual({ kind: "refused", code: row.code, field: row.pointer, remedy: row.remedy });

    expect(row.path === row.pointer || row.path.startsWith(row.pointer + "/")
      || row.code === "money_tax_evidence_mismatch" && row.pointer === "/verifiedMoney").toBe(true);
    const reported = pointerParent(input, row.pointer);
    expect(Object.hasOwn(reported.parent, reported.key)).toBe(row.value !== removeMember);

    if ("recalculate" in row && "verifiedMoney" in input) {
      const recalculate = row.arm === "exclusiveWaived" ? waivedMoney : exclusiveMoney;
      input.verifiedMoney = recalculate(input.planInput);
    } else if ("repair" in row) {
      const repair = pointerParent(input, row.repair.path);
      Object.defineProperty(repair.parent, repair.key, { value: row.repair.value });
    } else if (previous) Object.defineProperty(parent, key, previous);
    else if (Array.isArray(parent)) parent.pop();
    else Reflect.deleteProperty(parent, key);
    expect(composeCommerceQuoteMoneyV2(input).kind).toBe("composed");
  });
});

describe("position invariants in composition and sealed quotes", () => {
  const shipPosition = metadata("free-shipping");
  it.each(["inclusive", "exclusive"] as const)("retains fees on free %s shipping and refuses zero-charge positions", amountBasis => {
    const exclusive = amountBasis === "exclusive";
    const feeLines = [fee("free-delivery-fee", 2)];
    const planning = planInput({ listBasis: amountBasis, lines: [source("a", 1, 100, 1, exclusive ? "net" : "gross")],
      baseline: { ...baseline, amountBasis, delivery: [bucket("shipping", 0)], feeLines: exclusive ? [] : feeLines } });
    const plan = planned(planning);
    const evidence = (withPosition: boolean) => calculateCatalogueMoneyV2({
      ...plan.moneyInput, fees: [{ feeKey: feeLines[0].feeKey, amountMinor: 2 }],
    }, {
      kind: "local",
      components: plan.plan.components.map(({ ref }) => ({ ref, rates: ref.kind === "delivery" && withPosition
        ? [{ positionRef: shipPosition.positionRef, jurisdictionRef: shipPosition.jurisdictionRef, rateDecimal: "10" }] : [] })),
    });
    const composeInput = (withPosition: boolean): ComposeCommerceQuoteMoneyV2Input => {
      if (!exclusive) {
        const base = fiscalInput(planning);
        return withPosition ? { ...base, positions: [...base.positions, { ref: { kind: "delivery", bucketKey: "shipping" },
          position: shipPosition }] } : base;
      }
      return {
        planInput: planning, facts, allocationIds: [], feeLines, positions: withPosition ? [shipPosition] : [],
        taxEvidence: { ...localEvidence, kind: "tax_calculation" }, verifiedMoney: evidence(withPosition),
      };
    };
    const { money } = composed(composeInput(false));
    expect(money.feeLines).toStrictEqual(feeLines);
    expect(money.deliveryBuckets[0].parts[0].taxPositions).toEqual([]);
    expect(commerceQuoteV2Schema.safeParse(sealQuote(money)).success).toBe(true);
    const rejected = composeCommerceQuoteMoneyV2(composeInput(true));
    expect(rejected).toMatchObject({ kind: "refused", code: "money_tax_evidence_mismatch",
      field: exclusive ? "/verifiedMoney" : "/positions" });
    const [deliveryBucket] = money.deliveryBuckets;
    const badShipping = { ...deliveryBucket.parts[0], taxPositions: [{ ...shipPosition, taxableMinor: 0, taxMinor: 0, rateDecimal: "10" }] };
    const invalid = commerceQuoteV2Schema.safeParse(sealQuote({ ...money, deliveryBuckets: [{ ...deliveryBucket, parts: [badShipping] }] }));
    expect(invalid.error?.issues[0]).toMatchObject({ params: {
      code: "money_tax_evidence_mismatch", field: "/deliveryBuckets/0/parts/0/taxPositions",
      remedy: "Replay the original money and its matching tax evidence.",
    } });
    expect(rejected).toMatchObject({ remedy: exclusive ? "Recalculate tax for this exact planning input, then compose again."
      : "Supply evidence matching the planned money." });
  });

  it("requires one position for a positive inclusive state even at zero tax", () => {
    const input = fiscalInput(planInput());
    const { money } = composed(input);
    expect(money.lines[0].taxPositions).toHaveLength(1);
    expect(composeCommerceQuoteMoneyV2({ ...input, positions: [] })).toMatchObject({ kind: "refused", field: "/positions" });
    const bad = sealQuote({ ...money, lines: [{ ...money.lines[0], taxPositions: [] }] });
    expect(commerceQuoteV2Schema.safeParse(bad).error?.issues[0]).toMatchObject({
      params: { code: "money_tax_evidence_mismatch", field: "/lines/0/taxPositions" },
    });
  });
});
