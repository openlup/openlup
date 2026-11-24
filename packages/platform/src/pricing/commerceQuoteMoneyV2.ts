import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error, planCatalogueMoneyV2 } from "@openlup/core/pricing";
import type { CatalogueMoneyV2ComponentRef, CatalogueMoneyV2Input, CatalogueMoneyV2Plan,
  CatalogueMoneyV2Result, CatalogueMoneyV2State, CatalogueMoneyV2Tax } from "@openlup/core/pricing";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { CommerceCodeRejectionDetail } from "./contracts/evidence.js";
import type { PromotionEngineVersion } from "./contracts/offerPolicy.js";
import type { CommerceCodeRejection, CommerceQuoteDiscount } from "./contracts/quote.js";
import type { CommerceQuoteMoneyV2 as Body, DeliveryBucketV2, DiscountAllocationV2, FeeLineV2,
  MoneyLineV2, TaxPositionV2 } from "./contracts/quoteV2.js";
import { CATALOG_DRAFT_MAX_BYTES } from "../catalog/contracts/index.js";
import { quoteCodeRejectionDetailSchema } from "./quoteCodeRejectionDetails.js";
import { quoteDigest } from "./quoteDigest.js";
import { absentFeeBucket, admit, bucketSource, checkMoney, currency, engine, evidence, factsShape, feeLine,
  lineSource, minor, MoneyIssue, moneyRef, pointer, positionAmounts, positionMetadata, positionsMatchBasis, price, ref, remedies,
  shapePath, sumMinor, uuid } from "./quoteMoneyValidationV2.js";
import type { Code, Path } from "./quoteMoneyValidationV2.js";

const sourceShape = lineSource.extend({ amountKind: z.enum(["gross", "net"]) });
const deliveryShape = bucketSource.extend({ amountMinor: minor,
  threshold: z.strictObject({ flatMinor: minor, freeThresholdMinor: minor }).optional() });
const basis = z.enum(["inclusive", "exclusive"]);
const byKey = <T>(rows: z.ZodType<T[]>, key: (row: T) => string, path: Path) =>
  rows.superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const id = key(item);
      if (seen.has(id)) ctx.addIssue({ code: "custom", path: [index, ...path], message: remedies.money_input_invalid });
      seen.add(id);
    });
  });
const feeLinesShape = byKey(z.array(feeLine).max(256), fee => fee.feeKey, ["feeKey"]);
const candidateShape = z.strictObject({ amountBasis: basis, deliverySelectionRef: ref, feeLines: feeLinesShape,
  delivery: byKey(z.array(deliveryShape).max(256), row => row.bucketKey, ["bucketKey"]),
});
const adjustmentFields = { amountOffMinor: minor.refine(value => value > 0), adjustmentRef: moneyRef, evidenceRef: ref };
const adjustmentShape = z.discriminatedUnion("appliesTo", [
  z.strictObject({ ...adjustmentFields, appliesTo: z.enum(["line", "order_total"]), target: z.strictObject({ lineKeys: z.array(moneyRef).min(1).max(50) }) }),
  z.strictObject({ ...adjustmentFields, appliesTo: z.literal("shipping"), target: z.strictObject({ bucketKey: moneyRef }) }),
]);
type Source = Pick<MoneyLineV2, "lineKey" | "sourceOrdinal" | "sku" | "mode" | "quantity" | "unitBasisMinor" | "taxClassKey" | "assignmentRef">
  & Readonly<{ amountKind: "gross" | "net" }>;
type Candidate = Readonly<{
  amountBasis: Body["amountBasis"]; deliverySelectionRef: string;
  delivery: readonly (Omit<DeliveryBucketV2, "parts"> & { amountMinor: number; threshold?: { flatMinor: number; freeThresholdMinor: number } })[];
  feeLines: readonly FeeLineV2[]; adjustments: readonly Readonly<{
    amountOffMinor: number; appliesTo: CommerceQuoteDiscount["appliesTo"]; adjustmentRef: string; evidenceRef: string;
    target: Readonly<{ lineKeys: readonly string[] }> | Readonly<{ bucketKey: string }>;
  }>[];
}>;
type PositionMetadata = Omit<TaxPositionV2, "taxableMinor" | "taxMinor" | "rateDecimal">;
type SharedFacts = Pick<Body, "catalogueEvidenceRef" | "mode" | "cadence" | "destination" | "paymentLimits" | "coverageDigest">;
type CodeDiagnostics = Readonly<{
  codeRejections: readonly CommerceCodeRejection[]; codeRejectionDetails: readonly CommerceCodeRejectionDetail[];
}>;
type PromotionDiagnostics = Readonly<{ codeDiagnostics?: CodeDiagnostics;
  displacedCodes?: readonly (CommerceCodeRejection & { reason: "better_price_exists" })[];
}>;
type RateRows = Extract<CatalogueMoneyV2Tax, { kind: "inclusive" }>["components"];

/** @experimental Resolved list-basis prices, owner adjustments and delivery alternatives. Supply the promotion owner’s applied code values in order. */
export type PlanCommerceQuoteMoneyV2Input = Readonly<{
  currency: string; listBasis: Body["amountBasis"] | null; price: Body["price"]; engine: PromotionEngineVersion;
  lines: readonly Source[]; baseline: Omit<Candidate, "adjustments">; selected?: Candidate;
  codeDiagnostics?: CodeDiagnostics & { appliedCodes: readonly string[] };
}>;
/** @experimental Winning basis plan for offline tax composition. */
export type CommerceQuoteMoneyV2Plan = Readonly<{
  kind: "planned"; currency: string; price: Body["price"]; promotion: Body["promotion"]; lines: readonly Source[];
  winner: Candidate; moneyInput: CatalogueMoneyV2Input; plan: CatalogueMoneyV2Plan;
}> & PromotionDiagnostics;
/** @experimental Planning input and evidence required to assemble money for the winning candidate. */
export type ComposeCommerceQuoteMoneyV2Input = Readonly<{
  planInput: PlanCommerceQuoteMoneyV2Input; facts: SharedFacts;
  allocationIds: readonly Readonly<{ ref: CatalogueMoneyV2ComponentRef; sequence: number; allocationId: string }>[];
}> & (
  | Readonly<{ taxEvidence: Extract<Body["taxEvidence"], { kind: "fiscal_profile" }>; fiscal: RateRows;
      positions: readonly Readonly<{ ref: CatalogueMoneyV2ComponentRef; position: PositionMetadata }>[] }>
  | Readonly<{ taxEvidence: Extract<Body["taxEvidence"], { kind: "tax_calculation" }>;
      verifiedMoney: CatalogueMoneyV2Result; positions: readonly PositionMetadata[]; feeLines: readonly FeeLineV2[] }>
);
/** @experimental Fixed-prose refusal with a JSON-pointer field. */
export type CommerceQuoteMoneyV2Refusal = Readonly<{
  kind: "refused"; code: "money_input_invalid" | "money_amount_basis_mixed" | "shipping_tax_basis_empty"
  | "promotion_allocation_unsubstantiated" | "money_tax_evidence_mismatch" | "money_amount_out_of_range";
  field: string; remedy: string;
}>;

const segments = (field: string) => field.split("/").slice(1);
function fail(code: Code, field: string): never {
  throw new MoneyIssue(code, segments(field));
}
// Validate without replacing admitted owner diagnostics with parsed values.
function read(shape: z.ZodType, value: unknown): void {
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw new MoneyIssue("money_input_invalid", shapePath(parsed.error.issues[0]));
}

function planIssue(error: CatalogueMoneyV2Error, candidate: Path): MoneyIssue {
  const [group, index] = error.field.split(/[.[\]]+/u);
  if (error.code === "money_amount_out_of_range" || error.code === "shipping_tax_basis_empty") return new MoneyIssue(error.code, candidate);
  if (group === "adjustments") return new MoneyIssue("promotion_allocation_unsubstantiated", [...candidate, group, index]);
  const code = Object.hasOwn(remedies, error.code) ? error.code as Code : "money_input_invalid";
  const path = group === "sources" ? ["lines", index] : group === "delivery" ? [...candidate, group, index] : candidate;
  return new MoneyIssue(code, path);
}

function refusal(error: unknown, scope: string): CommerceQuoteMoneyV2Refusal {
  const issue = error instanceof MoneyIssue ? error : new MoneyIssue("money_input_invalid", segments(scope));
  return { kind: "refused", code: issue.code, field: pointer(issue.path), remedy: issue.remedy };
}

function planCandidate(candidate: Candidate, currencyCode: string, lines: readonly Source[], path: string, listBasis: Body["amountBasis"]) {
  const { amountBasis, delivery, feeLines } = candidate;
  if (amountBasis !== listBasis) throw new MoneyIssue("money_amount_basis_mixed", segments(path), "Supply candidate facts for the published list basis.");
  const { adjustments } = candidate;
  if (amountBasis === "exclusive" && feeLines.length) fail("money_input_invalid", path + "/feeLines");
  const orphan = absentFeeBucket(feeLines, new Set(delivery.map(bucket => bucket.bucketKey)));
  if (orphan !== -1) fail("money_input_invalid", path + "/feeLines/" + orphan);
  const shippingKeys = new Set(delivery.filter(bucket => bucket.kind === "shipping").map(bucket => bucket.bucketKey));
  const moneyInput: CatalogueMoneyV2Input = {
    amountBasis, sources: lines.map(({ lineKey, sourceOrdinal, quantity, unitBasisMinor }) => ({ lineKey, sourceOrdinal, quantity, unitBasisMinor })),
    delivery: delivery.map(({ bucketKey, kind, amountMinor }) => ({ bucketKey, deliveryKind: kind, amountMinor })),
    adjustments: adjustments.map(({ amountOffMinor, appliesTo, adjustmentRef, target }, index) => {
      if (appliesTo === "shipping" && "bucketKey" in target && !shippingKeys.has(target.bucketKey)) {
        fail("promotion_allocation_unsubstantiated", path + "/adjustments/" + index);
      }
      return { adjustmentRef, sequence: index + 1, amountMinor: amountOffMinor, target };
    }),
    fees: feeLines.map(({ feeKey, amountMinor }) => ({ feeKey, amountMinor })),
  };
  const plan = planCatalogueMoneyV2(moneyInput);
  const merchandise = sumMinor(plan.components.filter(item => item.ref.kind === "merchandise"), item => item.effectiveMinor);
  for (const [index, bucket] of delivery.entries()) {
    if (bucket.cost.currency !== currencyCode) fail("money_input_invalid", path + "/delivery/" + index);
    if (!bucket.threshold) continue;
    const { flatMinor, freeThresholdMinor } = bucket.threshold;
    const expected = merchandise >= BigInt(freeThresholdMinor) ? 0 : flatMinor;
    if (bucket.kind !== "shipping" || bucket.amountMinor !== expected) fail("money_input_invalid", path + "/delivery/" + index);
  }
  const fees = amountBasis === "inclusive" ? sumMinor(plan.fees, fee => fee.amountMinor) : 0n;
  return { winner: candidate, moneyInput, plan, score: sumMinor(plan.components, item => item.effectiveMinor) + fees };
}

const diagnosticsShape = z.strictObject({ appliedCodes: z.array(z.string()),
  codeRejections: z.array(z.strictObject({ code: z.string(), reason: z.enum([
    "not_recognized", "already_used", "not_eligible", "expired", "better_price_exists", "scope_not_applicable",
  ]) })), codeRejectionDetails: z.array(quoteCodeRejectionDetailSchema),
});

const sourceLines = byKey(z.array(sourceShape).min(1).max(50), line => line.lineKey, ["lineKey"]);
const planningShape = z.strictObject({
  currency, engine, price, lines: byKey(sourceLines, line => String(line.sourceOrdinal), ["sourceOrdinal"]), listBasis: basis.nullable(),
  baseline: candidateShape, selected: candidateShape.extend({
    adjustments: byKey(z.array(adjustmentShape).min(1).max(20), row => row.adjustmentRef, ["adjustmentRef"]),
  }).optional(), codeDiagnostics: diagnosticsShape.optional(),
});

function planAdmitted(input: PlanCommerceQuoteMoneyV2Input): CommerceQuoteMoneyV2Plan | CommerceQuoteMoneyV2Refusal {
  let scope = "/baseline";
  try {
    const { currency: currencyCode, price: priceFacts, lines } = input;
    const amountBasis = input.listBasis ?? "inclusive";
    const mixed = lines.findIndex(line => line.amountKind !== (amountBasis === "inclusive" ? "gross" : "net"));
    if (mixed !== -1) throw new MoneyIssue("money_amount_basis_mixed", ["lines", mixed], "Supply a line priced on the published list basis.");
    const baseline = planCandidate({ ...input.baseline, adjustments: [] }, currencyCode, lines, scope, amountBasis);
    scope = "/selected";
    const selected = input.selected && planCandidate(input.selected, currencyCode, lines, scope, amountBasis);
    const winner = selected && selected.score <= baseline.score ? selected : baseline;
    const diagnostics = input.codeDiagnostics;
    const displacedCodes = winner === baseline ? diagnostics?.appliedCodes.map(code => ({ code, reason: "better_price_exists" as const })) : undefined;
    return { kind: "planned", currency: currencyCode, price: priceFacts, lines,
      winner: winner.winner, moneyInput: winner.moneyInput, plan: winner.plan,
      promotion: { engine: input.engine, rankingRuleRef: amountBasis === "inclusive" ? "lowest_payable_gross" : "lowest_pre_tax.v1" },
      ...(diagnostics ? { codeDiagnostics: { codeRejectionDetails: diagnostics.codeRejectionDetails,
        codeRejections: diagnostics.codeRejections } } : {}), ...(displacedCodes?.length ? { displacedCodes } : {}) };
  } catch (error) { return refusal(error instanceof CatalogueMoneyV2Error ? planIssue(error, segments(scope)) : error, scope); }
}

/** @experimental For exclusive tax, derive the request from the unmodified plan for one immutable planning input and call verifyTaxQuoteResult on that exact request and result before composition. */
export function planCommerceQuoteMoneyV2(input: PlanCommerceQuoteMoneyV2Input): CommerceQuoteMoneyV2Plan | CommerceQuoteMoneyV2Refusal {
  try {
    const admitted = admit(input);
    read(planningShape, admitted);
    return planAdmitted(admitted);
  } catch (error) { return refusal(error, "/currency"); }
}

function componentKey(component: CatalogueMoneyV2ComponentRef): string {
  return JSON.stringify(component.kind === "merchandise"
    ? [component.kind, component.lineKey, component.sourceOrdinal] : [component.kind, component.bucketKey, component.sourceOrdinal]);
}
const verifiedMismatch = () => new MoneyIssue("money_tax_evidence_mismatch", ["verifiedMoney"],
  "Recalculate tax for this exact planning input, then compose again.");
const evidenceMismatch = (field: string) => new MoneyIssue("money_tax_evidence_mismatch", [field],
  "Supply evidence matching the planned money.");

function exclusiveResult(input: Extract<ComposeCommerceQuoteMoneyV2Input, { verifiedMoney: CatalogueMoneyV2Result }>, planned: CommerceQuoteMoneyV2Plan) {
  const { verifiedMoney } = input;
  const shipping = new Set(planned.winner.delivery.filter(bucket => bucket.kind === "shipping").map(bucket => bucket.bucketKey));
  for (const { ref, initial, final, allocations } of verifiedMoney.components) {
    const isShipping = ref.kind === "delivery" && shipping.has(ref.bucketKey);
    if ([initial, ...allocations.flatMap(({ before, after }) => [before, after]), final].some(({ amountMinor, netMinor, taxPositions }) =>
      !positionsMatchBasis(amountMinor, netMinor, taxPositions, false, isShipping))) throw verifiedMismatch();
  }
  const state = (row: CatalogueMoneyV2State, afterSequence: number) =>
    ({ afterSequence, amountMinor: row.amountMinor, taxPositions: row.taxPositions });
  const result = calculateCatalogueMoneyV2({ ...planned.moneyInput, fees: verifiedMoney.fees }, {
    kind: "provider", payableMinor: verifiedMoney.payableMinor, components: verifiedMoney.components.map(item => ({
      ref: item.ref, states: [state(item.initial, 0), ...item.allocations.map(row => state(row.after, row.sequence))],
    })),
  });
  if (!isDeepStrictEqual(result, verifiedMoney)) throw verifiedMismatch();
  const fees = new Map(input.feeLines.map(fee => [fee.feeKey, fee]));
  const feeLines = verifiedMoney.fees.map(({ feeKey, amountMinor }) => {
    const fee = fees.get(feeKey);
    if (fee?.amountMinor !== amountMinor) throw evidenceMismatch("feeLines");
    fees.delete(feeKey);
    return fee;
  });
  if (fees.size) throw evidenceMismatch("feeLines");
  return { result, feeLines };
}

function positionReader(input: ComposeCommerceQuoteMoneyV2Input, result: CatalogueMoneyV2Result) {
  const all = new Map(input.positions.map((row): readonly [string, PositionMetadata] => "ref" in row
    ? [componentKey(row.ref), row.position] : [row.positionRef, row]));
  const unused = new Set(all.keys());
  const fiscalRates = "fiscal" in input
    ? new Map(input.fiscal.map(row => [componentKey(row.ref), row.rateBps])) : undefined;
  const merchandise = new Map(result.components.flatMap(({ ref }) => ref.kind === "merchandise" ? [[ref.sourceOrdinal, ref] as const] : []));
  function metadata(key: string) {
    const entry = all.get(key);
    if (!entry) throw evidenceMismatch("positions");
    unused.delete(key);
    return entry;
  }
  return {
    checkUsed() { if (unused.size) throw evidenceMismatch("positions"); },
    read(component: CatalogueMoneyV2ComponentRef, state: CatalogueMoneyV2State): TaxPositionV2[] {
      if (!fiscalRates) return state.taxPositions.map(position => {
        const facts = metadata(position.positionRef);
        if (facts.jurisdictionRef !== position.jurisdictionRef) throw evidenceMismatch("positions");
        return { ...facts, ...position };
      });
      if (state.amountMinor === 0) return [];
      const rateRef = component.kind === "delivery" && component.sourceOrdinal !== undefined
        ? merchandise.get(component.sourceOrdinal)! : component;
      const rate = fiscalRates.get(componentKey(rateRef));
      if (rate === undefined) throw evidenceMismatch("fiscal");
      return [{ ...metadata(componentKey(component)), rateDecimal: String(rate / 100),
        taxableMinor: state.netMinor, taxMinor: state.taxMinor }];
    },
  };
}

function projectComponents(input: ComposeCommerceQuoteMoneyV2Input, planned: CommerceQuoteMoneyV2Plan, result: CatalogueMoneyV2Result) {
  const positions = positionReader(input, result);
  const ids = new Map(input.allocationIds.map(row => [componentKey(row.ref) + "/" + row.sequence, row]));
  function project({ ref, initial, final, allocations }: CatalogueMoneyV2Result["components"][number]) {
    const state = (row: CatalogueMoneyV2State) => ({
      basisMinor: row.amountMinor, netMinor: row.netMinor, taxMinor: row.taxMinor, taxPositions: positions.read(ref, row),
    });
    const discountAllocations: DiscountAllocationV2[] = allocations.map(share => {
      const { adjustmentRef, sequence, basisReductionMinor, netReductionMinor, taxReductionMinor } = share;
      const key = componentKey(ref) + "/" + sequence;
      const supplied = ids.get(key);
      if (!supplied) fail("money_input_invalid", "/allocationIds");
      ids.delete(key);
      return { allocationId: supplied.allocationId,
        adjustmentRef, sequence, basisReductionMinor, netReductionMinor, taxReductionMinor, source: "legacy_promotion",
        evidenceRef: planned.winner.adjustments[sequence - 1].evidenceRef, before: state(share.before), after: state(share.after) };
    });
    return { preDiscountMinor: initial.amountMinor, effectiveMinor: final.amountMinor, discountAllocations,
      netMinor: final.netMinor, taxMinor: final.taxMinor, lineTotalMinor: final.totalMinor, taxPositions: positions.read(ref, final) };
  }
  const lines: MoneyLineV2[] = [];
  const sources = new Map(planned.lines.map(source => [source.lineKey, source]));
  const parts = new Map<string, DeliveryBucketV2["parts"][number][]>();
  for (const component of result.components) {
    const { ref } = component;
    const money = project(component);
    if (ref.kind === "merchandise") {
      const { amountKind: _amountKind, ...line } = sources.get(ref.lineKey)!;
      lines.push({ ...line, ...money });
    } else {
      const bucket = parts.get(ref.bucketKey) ?? [];
      bucket.push({ ...money, ...(ref.sourceOrdinal === undefined ? {} : { sourceOrdinal: ref.sourceOrdinal }) });
      parts.set(ref.bucketKey, bucket);
    }
  }
  const deliveryBuckets = planned.winner.delivery.map(({ threshold: _threshold, amountMinor: _amount, ...bucket }) =>
    ({ ...bucket, parts: parts.get(bucket.bucketKey)! }));
  positions.checkUsed();
  if (ids.size) fail("money_input_invalid", "/allocationIds");
  return { lines, deliveryBuckets };
}

function compositionIssue(issue: MoneyIssue, candidate: Path, fiscal: boolean): MoneyIssue {
  const [field] = issue.path;
  if (field === "taxEvidence") return new MoneyIssue(issue.code, ["taxEvidence"], "Supply tax evidence with an expiry after its tax date.");
  if (field === "paymentLimits") return new MoneyIssue(issue.code, ["facts", field], "Supply ordered payment limits in the quote currency.");
  if (field === "feeLines") return new MoneyIssue(issue.code, fiscal ? [...candidate, field] : [field]);
  if (issue.code === "money_tax_evidence_mismatch") return fiscal ? evidenceMismatch("positions") : verifiedMismatch();
  return new MoneyIssue(issue.code, candidate);
}

const componentRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("merchandise"), lineKey: moneyRef, sourceOrdinal: minor.min(1) }),
  z.strictObject({ kind: z.literal("delivery"), bucketKey: moneyRef, sourceOrdinal: minor.min(1).optional() }),
]);
const coreState = z.strictObject({ amountMinor: minor, netMinor: minor, taxMinor: minor, totalMinor: minor,
  taxPositions: byKey(z.array(z.strictObject({ positionRef: moneyRef, jurisdictionRef: ref, ...positionAmounts })).max(32), row => row.positionRef, ["positionRef"]),
});
const resultShape = z.strictObject({ amountBasis: basis, netTotal: minor, taxTotal: minor, feeTotal: minor, payableMinor: minor,
  fees: byKey(z.array(feeLine.pick({ feeKey: true, amountMinor: true })).max(256), fee => fee.feeKey, ["feeKey"]),
  components: byKey(z.array(z.strictObject({ ref: componentRef, initial: coreState, final: coreState, allocations: z.array(z.strictObject({
    adjustmentRef: moneyRef, sequence: minor.min(1).max(20), basisReductionMinor: minor.min(1), beforeMinor: minor, afterMinor: minor,
    before: coreState, after: coreState, netReductionMinor: minor, taxReductionMinor: minor,
  })).max(20) })).max(512), row => componentKey(row.ref), ["ref"]),
}).superRefine(({ components }, ctx) => {
  const owners = new Map<string, number>();
  components.forEach(({ initial, final, allocations }, index) => {
    const states = [{ state: initial, path: ["initial"] }, ...allocations.flatMap(({ before, after }, i) => [
      { state: before, path: ["allocations", i, "before"] }, { state: after, path: ["allocations", i, "after"] },
    ]), { state: final, path: ["final"] }];
    states.forEach(({ state, path }) => state.taxPositions.forEach(({ positionRef }, i) => {
      const owner = owners.get(positionRef);
      if (owner === undefined) owners.set(positionRef, index);
      else if (owner !== index) ctx.addIssue({ code: "custom",
        path: ["components", index, ...path, "taxPositions", i, "positionRef"], message: remedies.money_input_invalid });
    }));
  });
});
const allocationIds = byKey(z.array(z.strictObject({ ref: componentRef, sequence: minor.min(1).max(20), allocationId: uuid })),
  row => componentKey(row.ref) + "/" + row.sequence, []);
const compositionFacts = z.discriminatedUnion("mode", [
  factsShape.omit({ cadence: true }).extend({ mode: z.literal("one_time") }),
  factsShape.extend({ mode: z.literal("subscription"), cadence: factsShape.shape.cadence.unwrap() }),
]);
const compositionShape = z.strictObject({ planInput: planningShape, facts: compositionFacts,
  allocationIds: byKey(allocationIds, row => row.allocationId, ["allocationId"]),
});
const fiscalPositions = byKey(z.array(z.strictObject({ ref: componentRef, position: positionMetadata })),
  row => componentKey(row.ref), ["ref"]);
const inclusiveShape = compositionShape.extend({
  taxEvidence: z.strictObject({ ...evidence, kind: z.literal("fiscal_profile") }),
  fiscal: byKey(z.array(z.strictObject({ ref: componentRef, rateBps: minor.max(10_000) })).max(512), row => componentKey(row.ref), ["ref"]),
  positions: byKey(fiscalPositions, row => row.position.positionRef, ["position", "positionRef"]),
});
const exclusiveShape = compositionShape.extend({
  taxEvidence: z.strictObject({ ...evidence, kind: z.literal("tax_calculation") }),
  verifiedMoney: resultShape, positions: byKey(z.array(positionMetadata), row => row.positionRef, ["positionRef"]), feeLines: feeLinesShape,
});

/** @experimental For exclusive tax, reuse the immutable planning input and pass the result verified by verifyTaxQuoteResult against the exact request derived from the unmodified plan. */
export function composeCommerceQuoteMoneyV2(input: ComposeCommerceQuoteMoneyV2Input):
  (Readonly<{ kind: "composed"; money: Body; moneyDigest: string }> & PromotionDiagnostics) | CommerceQuoteMoneyV2Refusal {
  let candidate = ["planInput"];
  let fiscal = false;
  try {
    const admitted = admit(input);
    read(admitted.taxEvidence?.kind === "tax_calculation" ? exclusiveShape : inclusiveShape, admitted);
    const planned = planAdmitted(admitted.planInput);
    if (planned.kind === "refused") return { ...planned, field: "/planInput" + planned.field };
    fiscal = "fiscal" in admitted;
    candidate = ["planInput", planned.winner.adjustments.length ? "selected" : "baseline"];
    if (fiscal !== (planned.moneyInput.amountBasis === "inclusive")) {
      throw new MoneyIssue("money_amount_basis_mixed", ["taxEvidence"], "Supply tax evidence for the planned amount basis.");
    }
    const { result, feeLines } = "fiscal" in admitted
      ? { result: calculateCatalogueMoneyV2(planned.moneyInput, { kind: "inclusive", components: admitted.fiscal }),
        feeLines: planned.winner.feeLines }
      : exclusiveResult(admitted, planned);
    const { amountBasis, netTotal, taxTotal, feeTotal, payableMinor } = result;
    const projected = { ...admitted.facts, ...projectComponents(admitted, planned, result), feeLines, amountBasis,
      netTotal, taxTotal, feeTotal, payableMinor, price: planned.price, currency: planned.currency,
      deliverySelectionRef: planned.winner.deliverySelectionRef, promotion: planned.promotion, taxEvidence: admitted.taxEvidence } as Body;
    const issue = checkMoney(projected);
    if (issue) throw compositionIssue(issue, candidate, fiscal);
    if (Buffer.byteLength(JSON.stringify(projected)) + 28 > CATALOG_DRAFT_MAX_BYTES) throw new MoneyIssue("money_input_invalid", candidate);
    return { kind: "composed", money: projected, moneyDigest: quoteDigest("commerce.quote-money.v2", projected),
      ...(planned.codeDiagnostics ? { codeDiagnostics: planned.codeDiagnostics } : {}),
      ...(planned.displacedCodes ? { displacedCodes: planned.displacedCodes } : {}) };
  } catch (error) {
    if (!(error instanceof CatalogueMoneyV2Error)) return refusal(error, "/planInput");
    return refusal(error.code === "money_amount_out_of_range" ? new MoneyIssue(error.code, candidate)
      : fiscal ? evidenceMismatch("fiscal") : verifiedMismatch(), "/planInput");
  }
}
