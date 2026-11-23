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
  lineSource, minor, MoneyIssue, moneyRef, pointer, positionAmounts, positionMetadata, price, ref, remedies,
  shapePath, sumMinor, uuid } from "./quoteMoneyValidationV2.js";
import type { Code, Path } from "./quoteMoneyValidationV2.js";

const sourceShape = lineSource.extend({ amountKind: z.enum(["gross", "net"]) });
const deliveryShape = bucketSource.extend({ amountMinor: minor,
  threshold: z.strictObject({ flatMinor: minor, freeThresholdMinor: minor }).optional() });
const basis = z.enum(["inclusive", "exclusive"]);
const candidateShape = z.strictObject({
  amountBasis: basis, deliverySelectionRef: ref, delivery: z.array(deliveryShape).max(256), feeLines: z.array(feeLine).max(256),
});
const adjustmentShape = z.strictObject({
  amountOffMinor: minor.refine(value => value > 0), appliesTo: z.enum(["line", "order_total", "shipping"]), adjustmentRef: moneyRef, evidenceRef: ref,
  target: z.union([z.strictObject({ lineKeys: z.array(moneyRef).min(1).max(50) }), z.strictObject({ bucketKey: moneyRef })]),
});
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
function read<T>(shape: z.ZodType<T>, value: unknown, field: string, code: Code = "money_input_invalid"): T {
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw new MoneyIssue(code, [...segments(field), ...shapePath(parsed.error.issues[0])]);
  return parsed.data;
}

function coreIssue(error: CatalogueMoneyV2Error, scope: string, planning: boolean): MoneyIssue {
  const [group, ...tail] = error.field.replace(/\[(\d+)\]/g, ".$1").split(".");
  let code: Code = error.code in remedies ? error.code as Code : "money_input_invalid";
  if (group === "adjustments") code = "promotion_allocation_unsubstantiated";
  if (group === "tax") {
    code = tail.includes("states") ? "promotion_allocation_unsubstantiated" : "money_tax_evidence_mismatch";
    if (scope === "/fiscal") return new MoneyIssue(code, ["fiscal", ...tail.slice(tail[0] === "components" ? 1 : tail.length)]);
    const path = error.field.replace(/^tax/, "/verifiedMoney")
      .replace(/\.states\[(\d+)\]\.afterSequence$/, (_match, index: string) => ".allocations/" + (Number(index) - 1) + "/sequence")
      .replace(/\.states\[0\]/, ".initial").replace(/\.states\[(\d+)\]/, (_match, index: string) => ".allocations/" + (Number(index) - 1) + "/after")
      .replace(/\.states$/, ".allocations").replace(/\[(\d+)\]/g, ".$1").replaceAll(".", "/");
    return new MoneyIssue(code, segments(path));
  }
  const names: Record<string, string> = { sources: "lines", fees: "feeLines", deliveryKind: "kind",
    preDiscountMinor: "unitBasisMinor", amountMinor: group === "adjustments" ? "amountOffMinor" : "amountMinor" };
  const parts = [group, ...tail].map(key => planning ? names[key] ?? key : key);
  if (planning) return new MoneyIssue(code, group === "sources" ? parts : group === "input" ? segments(scope) : [...segments(scope), ...parts]);
  if (group.endsWith("Total") || group === "payableMinor") return new MoneyIssue(code, ["facts", "paymentLimits", "maxMinor"]);
  return new MoneyIssue(code, [...segments(scope), ...(group === "fees" && scope === "/verifiedMoney" ? parts : [])]);
}

function refusal(error: unknown, scope: string, planning = false): CommerceQuoteMoneyV2Refusal {
  const issue = error instanceof MoneyIssue ? error : error instanceof CatalogueMoneyV2Error ? coreIssue(error, scope, planning)
    : new MoneyIssue("money_input_invalid", segments(scope));
  return { kind: "refused", code: issue.code, field: pointer(issue.path), remedy: issue.remedy };
}

function planCandidate(candidate: Candidate, currencyCode: string, lines: readonly Source[], path: string, listBasis: Body["amountBasis"]) {
  const { amountBasis, delivery, feeLines } = candidate;
  if (amountBasis !== listBasis) fail("money_amount_basis_mixed", path + "/amountBasis");
  const { adjustments } = candidate;
  if (amountBasis === "exclusive" && feeLines.length) fail("money_input_invalid", path + "/feeLines");
  const orphan = absentFeeBucket(feeLines, new Set(delivery.map(bucket => bucket.bucketKey)));
  if (orphan !== -1) fail("money_input_invalid", path + "/feeLines/" + orphan + "/scope/bucketKey");
  const adjustmentRefs = new Set<string>();
  const shippingKeys = new Set(delivery.filter(bucket => bucket.kind === "shipping").map(bucket => bucket.bucketKey));
  const moneyInput: CatalogueMoneyV2Input = {
    amountBasis, sources: lines.map(({ lineKey, sourceOrdinal, quantity, unitBasisMinor }) => ({ lineKey, sourceOrdinal, quantity, unitBasisMinor })),
    delivery: delivery.map(({ bucketKey, kind, amountMinor }) => ({ bucketKey, deliveryKind: kind, amountMinor })),
    adjustments: adjustments.map(({ amountOffMinor, appliesTo, adjustmentRef, target }, index) => {
      const at = path + "/adjustments/" + index;
      if (adjustmentRefs.has(adjustmentRef)) fail("promotion_allocation_unsubstantiated", at + "/adjustmentRef");
      adjustmentRefs.add(adjustmentRef);
      if (appliesTo === "shipping" ? !("bucketKey" in target) || !shippingKeys.has(target.bucketKey) : !("lineKeys" in target)) {
        fail("promotion_allocation_unsubstantiated", at + "/target");
      }
      return { adjustmentRef, sequence: index + 1, amountMinor: amountOffMinor, target };
    }),
    fees: feeLines.map(({ feeKey, amountMinor }) => ({ feeKey, amountMinor })),
  };
  const plan = planCatalogueMoneyV2(moneyInput);
  const merchandise = sumMinor(plan.components.filter(item => item.ref.kind === "merchandise"), item => item.effectiveMinor);
  for (const [index, bucket] of delivery.entries()) {
    if (bucket.cost.currency !== currencyCode) fail("money_input_invalid", path + "/delivery/" + index + "/cost/currency");
    if (!bucket.threshold) continue;
    const { flatMinor, freeThresholdMinor } = bucket.threshold;
    const expected = merchandise >= BigInt(freeThresholdMinor) ? 0 : flatMinor;
    if (bucket.kind !== "shipping" || bucket.amountMinor !== expected) fail("money_input_invalid", path + "/delivery/" + index + "/amountMinor");
  }
  const fees = amountBasis === "inclusive" ? sumMinor(plan.fees, fee => fee.amountMinor) : 0n;
  return { winner: candidate, moneyInput, plan, score: sumMinor(plan.components, item => item.effectiveMinor) + fees };
}

const diagnosticsShape = z.looseObject({ appliedCodes: z.array(z.string()),
  codeRejections: z.array(z.looseObject({ code: z.string(), reason: z.enum([
    "not_recognized", "already_used", "not_eligible", "expired", "better_price_exists", "scope_not_applicable",
  ]) })), codeRejectionDetails: z.array(quoteCodeRejectionDetailSchema),
});

function planAdmitted(input: PlanCommerceQuoteMoneyV2Input): CommerceQuoteMoneyV2Plan | CommerceQuoteMoneyV2Refusal {
  let scope = "/baseline";
  try {
    const currencyCode = read(currency, input.currency, "/currency");
    read(engine, input.engine, "/engine");
    const priceFacts = read(price, input.price, "/price");
    const lines = read(z.array(sourceShape).min(1).max(50), input.lines, "/lines");
    const amountBasis = read(basis.nullable(), input.listBasis, "/listBasis") ?? "inclusive";
    const baselineFacts = read(candidateShape, input.baseline, "/baseline");
    const selectedFacts = read(candidateShape.extend({ adjustments: z.array(z.unknown()) }).optional(), input.selected, "/selected");
    const adjustments = selectedFacts && read(z.array(adjustmentShape).min(1).max(20),
      selectedFacts.adjustments, "/selected/adjustments", "promotion_allocation_unsubstantiated");
    read(diagnosticsShape.optional(), input.codeDiagnostics, "/codeDiagnostics");
    const mixed = lines.findIndex(line => line.amountKind !== (amountBasis === "inclusive" ? "gross" : "net"));
    if (mixed !== -1) fail("money_amount_basis_mixed", "/lines/" + mixed + "/amountKind");
    const baseline = planCandidate({ ...baselineFacts, adjustments: [] }, currencyCode, lines, scope, amountBasis);
    scope = "/selected";
    const selected = selectedFacts && adjustments && planCandidate({ ...selectedFacts, adjustments }, currencyCode, lines, scope, amountBasis);
    const winner = selected && selected.score <= baseline.score ? selected : baseline;
    const diagnostics = input.codeDiagnostics;
    const displacedCodes = winner === baseline ? diagnostics?.appliedCodes.map(code => ({ code, reason: "better_price_exists" as const })) : undefined;
    return { kind: "planned", currency: currencyCode, price: priceFacts, lines,
      winner: winner.winner, moneyInput: winner.moneyInput, plan: winner.plan,
      promotion: { engine: input.engine, rankingRuleRef: amountBasis === "inclusive" ? "lowest_payable_gross" : "lowest_pre_tax.v1" },
      ...(diagnostics ? { codeDiagnostics: { codeRejectionDetails: diagnostics.codeRejectionDetails,
        codeRejections: diagnostics.codeRejections } } : {}), ...(displacedCodes?.length ? { displacedCodes } : {}) };
  } catch (error) { return refusal(error, scope, true); }
}

/** @experimental For exclusive tax, derive the request from the unmodified plan for one immutable planning input and call verifyTaxQuoteResult on that exact request and result before composition. */
export function planCommerceQuoteMoneyV2(input: PlanCommerceQuoteMoneyV2Input): CommerceQuoteMoneyV2Plan | CommerceQuoteMoneyV2Refusal {
  try { return planAdmitted(admit(input)); }
  catch (error) { return refusal(error, "/currency"); }
}

function componentKey(component: CatalogueMoneyV2ComponentRef): string {
  return JSON.stringify(component.kind === "merchandise"
    ? [component.kind, component.lineKey, component.sourceOrdinal] : [component.kind, component.bucketKey, component.sourceOrdinal]);
}
function uniqueMap<T>(entries: readonly T[], key: (item: T) => string, code: Code, field: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const [index, item] of entries.entries()) {
    const id = key(item);
    if (result.has(id)) fail(code, field + "/" + index);
    result.set(id, item);
  }
  return result;
}

function exclusiveResult(input: Extract<ComposeCommerceQuoteMoneyV2Input, { verifiedMoney: CatalogueMoneyV2Result }>, planned: CommerceQuoteMoneyV2Plan) {
  const { verifiedMoney } = input;
  const fees = uniqueMap(input.feeLines, fee => fee.feeKey,
    "money_tax_evidence_mismatch", "/feeLines");
  const feeLines = verifiedMoney.fees.map(({ feeKey, amountMinor }) => {
    const fee = fees.get(feeKey);
    if (!fee) fail("money_tax_evidence_mismatch", "/feeLines");
    if (fee.amountMinor !== amountMinor) fail("money_tax_evidence_mismatch", "/feeLines/" + input.feeLines.findIndex(row => row.feeKey === feeKey) + "/amountMinor");
    fees.delete(feeKey);
    return fee;
  });
  if (fees.size) fail("money_tax_evidence_mismatch", "/feeLines");
  const state = (row: CatalogueMoneyV2State, afterSequence: number) =>
    ({ afterSequence, amountMinor: row.amountMinor, taxPositions: row.taxPositions });
  const result = calculateCatalogueMoneyV2({ ...planned.moneyInput, fees: verifiedMoney.fees }, {
    kind: "provider", payableMinor: verifiedMoney.payableMinor, components: verifiedMoney.components.map(item => ({
      ref: item.ref, states: [state(item.initial, 0), ...item.allocations.map(row => state(row.after, row.sequence))],
    })),
  });
  if (!isDeepStrictEqual(result, verifiedMoney)) fail("money_tax_evidence_mismatch", "/verifiedMoney");
  return { result, feeLines };
}

function positionReader(input: ComposeCommerceQuoteMoneyV2Input, result: CatalogueMoneyV2Result) {
  const remaining = uniqueMap(input.positions.map((row, index) => "ref" in row
    ? { index, key: componentKey(row.ref), position: row.position } : { index, key: row.positionRef, position: row }),
  entry => entry.key, "money_tax_evidence_mismatch", "/positions");
  const all = new Map(remaining);
  const fiscalRates = "fiscal" in input
    ? new Map(input.fiscal.map(row => [componentKey(row.ref), row.rateBps])) : undefined;
  const merchandise = new Map(result.components.flatMap(({ ref }) => ref.kind === "merchandise" ? [[ref.sourceOrdinal, ref] as const] : []));
  function metadata(key: string) {
    const entry = all.get(key);
    if (!entry) fail("money_tax_evidence_mismatch", "/positions");
    remaining.delete(key);
    return entry;
  }
  return {
    checkUsed() { if (remaining.size) fail("money_tax_evidence_mismatch", "/positions"); },
    read(component: CatalogueMoneyV2ComponentRef, state: CatalogueMoneyV2State): TaxPositionV2[] {
      if (!fiscalRates) return state.taxPositions.map(position => {
        const { position: facts, index } = metadata(position.positionRef);
        if (facts.jurisdictionRef !== position.jurisdictionRef) fail("money_tax_evidence_mismatch", "/positions/" + index + "/jurisdictionRef");
        return { ...facts, ...position };
      });
      if (state.amountMinor === 0) return [];
      const rateRef = component.kind === "delivery" && component.sourceOrdinal !== undefined
        ? merchandise.get(component.sourceOrdinal)! : component;
      const rate = fiscalRates.get(componentKey(rateRef));
      if (rate === undefined) fail("money_tax_evidence_mismatch", "/fiscal");
      return [{ ...metadata(componentKey(component)).position, rateDecimal: String(rate / 100),
        taxableMinor: state.netMinor, taxMinor: state.taxMinor }];
    },
  };
}

function projectComponents(input: ComposeCommerceQuoteMoneyV2Input, planned: CommerceQuoteMoneyV2Plan, result: CatalogueMoneyV2Result) {
  const positions = positionReader(input, result);
  const ids = uniqueMap(input.allocationIds, row => componentKey(row.ref) + "/" + row.sequence,
    "promotion_allocation_unsubstantiated", "/allocationIds");
  function project({ ref, initial, final, allocations }: CatalogueMoneyV2Result["components"][number]) {
    const state = (row: CatalogueMoneyV2State) => ({
      basisMinor: row.amountMinor, netMinor: row.netMinor, taxMinor: row.taxMinor, taxPositions: positions.read(ref, row),
    });
    const discountAllocations: DiscountAllocationV2[] = allocations.map(share => {
      const { adjustmentRef, sequence, basisReductionMinor, netReductionMinor, taxReductionMinor } = share;
      const key = componentKey(ref) + "/" + sequence;
      const supplied = ids.get(key);
      if (!supplied) fail("promotion_allocation_unsubstantiated", "/allocationIds");
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
  if (ids.size) fail("promotion_allocation_unsubstantiated", "/allocationIds");
  return { lines, deliveryBuckets };
}

function compositionPath(input: ComposeCommerceQuoteMoneyV2Input, candidate: Path, money: Body, path: Path): Path {
  const [root, index, ...tail] = path;
  if (root === "payableMinor") return money.payableMinor === 0 ? candidate : ["facts", "paymentLimits", money.payableMinor > input.facts.paymentLimits.maxMinor ? "maxMinor" : "minMinor"];
  if (root === "feeLines") {
    if ("fiscal" in input) return [...candidate, ...path];
    const feeIndex = input.feeLines.findIndex(fee => fee.feeKey === money.feeLines[Number(index)]?.feeKey);
    return feeIndex < 0 ? ["feeLines"] : ["feeLines", feeIndex, ...tail];
  }
  if (root !== "lines" && root !== "deliveryBuckets") return root === "taxEvidence" ? path : ["facts", ...path];
  const line = root === "lines" ? money.lines[Number(index)] : undefined;
  const bucket = root === "deliveryBuckets" ? money.deliveryBuckets[Number(index)] : undefined;
  const component = line ?? bucket?.parts[Number(tail[1])];
  const shareIndex = tail.indexOf("discountAllocations");
  const allocation = Number(tail[shareIndex + 1]);
  const taxIndex = tail.indexOf("taxPositions");
  const matches = (ref: CatalogueMoneyV2ComponentRef) => ref.kind === "merchandise" ? ref.lineKey === line?.lineKey
    : ref.bucketKey === bucket?.bucketKey && ref.sourceOrdinal === (component && "sourceOrdinal" in component ? component.sourceOrdinal : undefined);
  if (taxIndex >= 0) {
    if ("fiscal" in input) return ["positions", input.positions.findIndex(({ ref }) => matches(ref)), "position", ...tail.slice(taxIndex + 2)];
    const row = input.verifiedMoney.components.findIndex(({ ref }) => matches(ref));
    const state = shareIndex < 0 ? ["final"] : ["allocations", allocation, tail[shareIndex + 2]];
    return ["verifiedMoney", "components", row, ...state, ...tail.slice(taxIndex)];
  }
  if (shareIndex >= 0) {
    const id = input.allocationIds.findIndex(row => row.allocationId === component?.discountAllocations[allocation]?.allocationId && matches(row.ref));
    return ["allocationIds", id, "allocationId"];
  }
  return line ? ["planInput", "lines"] : [...candidate, "delivery", index];
}

const componentRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("merchandise"), lineKey: moneyRef, sourceOrdinal: minor }),
  z.strictObject({ kind: z.literal("delivery"), bucketKey: moneyRef, sourceOrdinal: minor.optional() }),
]);
const coreState = z.strictObject({ amountMinor: minor, netMinor: minor, taxMinor: minor, totalMinor: minor,
  taxPositions: z.array(z.strictObject({ positionRef: moneyRef, jurisdictionRef: ref, ...positionAmounts })),
});
const resultShape = z.strictObject({ amountBasis: basis, netTotal: minor, taxTotal: minor, feeTotal: minor, payableMinor: minor,
  fees: z.array(feeLine.pick({ feeKey: true, amountMinor: true })),
  components: z.array(z.strictObject({ ref: componentRef, initial: coreState, final: coreState, allocations: z.array(z.strictObject({
    adjustmentRef: moneyRef, sequence: minor, basisReductionMinor: minor, beforeMinor: minor, afterMinor: minor,
    before: coreState, after: coreState, netReductionMinor: minor, taxReductionMinor: minor,
  })) })),
});
const compositionShape = z.looseObject({ planInput: z.looseObject({}), facts: factsShape,
  taxEvidence: z.strictObject({ kind: z.enum(["fiscal_profile", "tax_calculation"]), ...evidence }),
  allocationIds: z.array(z.strictObject({ ref: componentRef, sequence: minor, allocationId: uuid })),
});
const fiscalShape = z.array(z.strictObject({ ref: componentRef, rateBps: z.number() }));
const fiscalPositions = z.array(z.strictObject({ ref: componentRef, position: positionMetadata }));

/** @experimental For exclusive tax, reuse the immutable planning input and pass the result verified by verifyTaxQuoteResult against the exact request derived from the unmodified plan. */
export function composeCommerceQuoteMoneyV2(input: ComposeCommerceQuoteMoneyV2Input):
  (Readonly<{ kind: "composed"; money: Body; moneyDigest: string }> & PromotionDiagnostics) | CommerceQuoteMoneyV2Refusal {
  let scope = "/planInput";
  try {
    const admitted = admit(input);
    read(compositionShape, admitted, "");
    const { taxEvidence } = admitted;
    if (!("fiscal" in admitted) && !("verifiedMoney" in admitted) && taxEvidence.kind === "fiscal_profile") fail("money_input_invalid", "/fiscal");
    const fiscal = "fiscal" in admitted;
    if (fiscal) {
      read(fiscalShape, admitted.fiscal, "/fiscal", "money_tax_evidence_mismatch");
      read(fiscalPositions, admitted.positions, "/positions", "money_tax_evidence_mismatch");
    } else {
      read(resultShape, admitted.verifiedMoney, "/verifiedMoney");
      read(z.array(positionMetadata), admitted.positions, "/positions", "money_tax_evidence_mismatch");
      read(z.array(feeLine).max(256), admitted.feeLines, "/feeLines");
    }
    const planned = planAdmitted(admitted.planInput);
    if (planned.kind === "refused") return { ...planned, field: "/planInput" + planned.field };
    if ((planned.moneyInput.amountBasis === "inclusive") !== fiscal) fail("money_amount_basis_mixed", "/planInput/listBasis");
    if ((taxEvidence.kind === "fiscal_profile") !== fiscal) fail("money_amount_basis_mixed", "/taxEvidence/kind");
    scope = fiscal ? "/fiscal" : "/verifiedMoney";
    const { result, feeLines } = fiscal
      ? { result: calculateCatalogueMoneyV2(planned.moneyInput, { kind: "inclusive", components: admitted.fiscal }),
        feeLines: planned.winner.feeLines }
      : exclusiveResult(admitted, planned);
    const { amountBasis, netTotal, taxTotal, feeTotal, payableMinor } = result;
    const projected = { ...admitted.facts, ...projectComponents(admitted, planned, result), feeLines, amountBasis,
      netTotal, taxTotal, feeTotal, payableMinor, taxEvidence, price: planned.price, currency: planned.currency,
      deliverySelectionRef: planned.winner.deliverySelectionRef, promotion: planned.promotion } as Body;
    const candidate = ["planInput", planned.winner.adjustments.length ? "selected" : "baseline"];
    const issue = checkMoney(projected);
    if (issue) throw new MoneyIssue(issue.code, compositionPath(admitted, candidate, projected, issue.path), issue.remedy);
    if (Buffer.byteLength(JSON.stringify(projected)) + 28 > CATALOG_DRAFT_MAX_BYTES) throw new MoneyIssue("money_input_invalid", candidate);
    return { kind: "composed", money: projected, moneyDigest: quoteDigest("commerce.quote-money.v2", projected),
      ...(planned.codeDiagnostics ? { codeDiagnostics: planned.codeDiagnostics } : {}),
      ...(planned.displacedCodes ? { displacedCodes: planned.displacedCodes } : {}) };
  } catch (error) { return refusal(error, scope); }
}
