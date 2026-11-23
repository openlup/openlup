import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error, planCatalogueMoneyV2 } from "@openlup/core/pricing";
import type { CatalogueMoneyV2ComponentRef, CatalogueMoneyV2Input, CatalogueMoneyV2Plan,
  CatalogueMoneyV2Result, CatalogueMoneyV2State, CatalogueMoneyV2Tax } from "@openlup/core/pricing";
import { z } from "zod";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import type { CommerceCodeRejectionDetail } from "./contracts/evidence.js";
import type { PromotionEngineVersion } from "./contracts/offerPolicy.js";
import type { CommerceCodeRejection, CommerceQuoteDiscount } from "./contracts/quote.js";
import type { CommerceQuoteMoneyV2 as Body, DeliveryBucketV2, DiscountAllocationV2, FeeLineV2,
  MoneyLineV2, TaxPositionV2 } from "./contracts/quoteV2.js";
import { quoteDigest } from "./quoteDigest.js";
import { bucketSource, checkMoney, currency, engine, feeLine, lineSource, minor, moneyRef, moneyShape,
  pointer, positionMetadata, price, ref, sumMinor, uuid } from "./quoteMoneyValidationV2.js";

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
type RateRows = Extract<CatalogueMoneyV2Tax, { kind: "inclusive" }>["components"];

/** @experimental Resolved list-basis prices, owner adjustments and delivery alternatives. Use submitted spellings for applied codes. */
export type PlanCommerceQuoteMoneyV2Input = Readonly<{
  currency: string; listBasis: Body["amountBasis"] | null; price: Body["price"]; engine: PromotionEngineVersion;
  lines: readonly Source[]; baseline: Omit<Candidate, "adjustments">; selected?: Candidate;
  codeDiagnostics?: CodeDiagnostics & { submittedCodes: readonly string[]; appliedCodes: readonly string[] };
}>;
/** @experimental Winning basis plan for offline tax composition. */
export type CommerceQuoteMoneyV2Plan = Readonly<{
  kind: "planned"; currency: string; price: Body["price"]; promotion: Body["promotion"]; lines: readonly Source[];
  winner: Candidate; moneyInput: CatalogueMoneyV2Input; plan: CatalogueMoneyV2Plan; codeDiagnostics?: CodeDiagnostics;
}>;
/** @experimental Evidence required to assemble money for the winning plan. */
export type ComposeCommerceQuoteMoneyV2Input = Readonly<{
  planned: CommerceQuoteMoneyV2Plan; facts: SharedFacts;
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

type Code = CommerceQuoteMoneyV2Refusal["code"];
const remedies: Record<Code, string> = {
  money_input_invalid: "Supply the documented value at this field.",
  money_amount_basis_mixed: "Select a published list with the required basis and obtain a fresh quote.",
  shipping_tax_basis_empty: "Select a supported delivery pricing policy.",
  promotion_allocation_unsubstantiated: "Obtain a quote using a supported promotion combination.",
  money_tax_evidence_mismatch: "Replay the original money and its matching tax evidence.",
  money_amount_out_of_range: "Choose a supported amount and obtain a fresh quote.",
};
class MoneyRefusal extends Error {
  readonly result: CommerceQuoteMoneyV2Refusal;
  constructor(code: Code, field: string) {
    super(remedies[code]);
    this.result = { kind: "refused", code, field, remedy: remedies[code] };
  }
}
function fail(code: Code, field: string): never {
  throw new MoneyRefusal(code, field);
}
function read<T>(shape: z.ZodType<T>, value: unknown, field: string, code: Code = "money_input_invalid"): T {
  const parsed = shape.safeParse(value);
  if (!parsed.success) fail(code, field + pointer(parsed.error.issues[0].path));
  return parsed.data;
}
function handle(error: unknown, taxField = "/verifiedMoney"): CommerceQuoteMoneyV2Refusal {
  if (error instanceof MoneyRefusal) return error.result;
  if (!(error instanceof CatalogueMoneyV2Error)) throw error;
  const field = "/" + error.field.replace(/\[(\d+)\]/g, ".$1").replaceAll(".", "/")
    .replace(/^sources(?=\/|$)/, "lines").replace(/^delivery(?=\/|$)/, "deliveryBuckets");
  let code: Code = "money_input_invalid";
  if (error.code in remedies) code = error.code as Code;
  if (field.startsWith("/adjustments")) code = "promotion_allocation_unsubstantiated";
  if (field.startsWith("/tax") || error.code === "money_payable_mismatch") code = "money_tax_evidence_mismatch";
  if (/^\/tax\/components\/\d+\/states(?:$|\/\d+\/(?:afterSequence|amountMinor)$)/u.test(field)) {
    code = "promotion_allocation_unsubstantiated";
  }
  const affected = field.startsWith("/tax/") ? taxField : field;
  return { kind: "refused", code, field: code === "shipping_tax_basis_empty" ? "/deliveryBuckets" : affected, remedy: remedies[code] };
}

function planCandidate(candidate: Candidate, currencyCode: string, lines: readonly Source[]) {
  const { amountBasis, delivery, feeLines } = candidate;
  if (!Array.isArray(candidate.adjustments) || candidate.adjustments.length > 20) {
    fail("promotion_allocation_unsubstantiated", "/adjustments");
  }
  const adjustments = candidate.adjustments.map((adjustment, index) =>
    read(adjustmentShape, adjustment, "/adjustments/" + index, "promotion_allocation_unsubstantiated"));
  if (delivery.some(bucket => bucket.cost.currency !== currencyCode)) fail("money_input_invalid", "/deliveryBuckets");
  if (amountBasis === "exclusive" && feeLines.length) fail("money_input_invalid", "/feeLines");
  const adjustmentRefs = new Set<string>();
  const shippingKeys = new Set(delivery.filter(bucket => bucket.kind === "shipping").map(bucket => bucket.bucketKey));
  const moneyInput: CatalogueMoneyV2Input = {
    amountBasis, sources: lines.map(({ lineKey, sourceOrdinal, quantity, unitBasisMinor }) => ({ lineKey, sourceOrdinal, quantity, unitBasisMinor })),
    delivery: delivery.map(({ bucketKey, kind, amountMinor }) => ({ bucketKey, deliveryKind: kind, amountMinor })),
    adjustments: adjustments.map(({ amountOffMinor, appliesTo, adjustmentRef, target }, index) => {
      const at = "/adjustments/" + index;
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
    if (!bucket.threshold) continue;
    const { flatMinor, freeThresholdMinor } = bucket.threshold;
    const expected = merchandise >= BigInt(freeThresholdMinor) ? 0 : flatMinor;
    if (bucket.kind !== "shipping" || bucket.amountMinor !== expected) fail("money_input_invalid", "/deliveryBuckets/" + index + "/amountMinor");
  }
  const fees = amountBasis === "inclusive" ? sumMinor(plan.fees, fee => fee.amountMinor) : 0n;
  return { winner: { ...candidate, adjustments }, moneyInput, plan, score: sumMinor(plan.components, item => item.effectiveMinor) + fees };
}

function codeDiagnostics(input: PlanCommerceQuoteMoneyV2Input["codeDiagnostics"], baselineWins: boolean): CodeDiagnostics | undefined {
  if (!input) return undefined;
  const { appliedCodes, submittedCodes, codeRejections, codeRejectionDetails } = input;
  if (!baselineWins || !appliedCodes.length) return { codeRejections, codeRejectionDetails };
  const rejected = new Set(codeRejections.map(row => row.code));
  const displaced = [...new Set(appliedCodes)].filter(code => !rejected.has(code));
  const ranks = new Map(submittedCodes.map((code, index) => [code, index] as const).reverse());
  const rank = (code: string) => ranks.get(code) ?? submittedCodes.length;
  const pending = displaced.sort((left, right) => rank(left) - rank(right));
  const amended: CommerceCodeRejection[] = [];
  let next = 0;
  for (const rejection of codeRejections) {
    while (next < pending.length && rank(pending[next]) < rank(rejection.code)) {
      amended.push({ code: pending[next++], reason: "better_price_exists" });
    }
    amended.push(rejection);
  }
  for (const code of pending.slice(next)) amended.push({ code, reason: "better_price_exists" });
  return { codeRejections: amended, codeRejectionDetails };
}

/** @experimental Rank the supplied owner outcome and the no-adjustment baseline on their list basis. */
export function planCommerceQuoteMoneyV2(input: PlanCommerceQuoteMoneyV2Input): CommerceQuoteMoneyV2Plan | CommerceQuoteMoneyV2Refusal {
  try {
    const currencyCode = read(currency, input.currency, "/currency");
    read(engine, input.engine, "/promotion/engine");
    const priceFacts = read(price, input.price, "/price");
    const lines = read(z.array(sourceShape).min(1).max(50), input.lines, "/lines");
    const amountBasis = read(basis.nullable(), input.listBasis, "/amountBasis") ?? "inclusive";
    if (input.baseline.amountBasis !== amountBasis || (input.selected && input.selected.amountBasis !== amountBasis)
      || lines.some(line => line.amountKind !== (amountBasis === "inclusive" ? "gross" : "net"))) {
      fail("money_amount_basis_mixed", "/amountBasis");
    }
    const baseline = planCandidate({ ...read(candidateShape, input.baseline, "/baseline"), adjustments: [] }, currencyCode, lines);
    let winner = baseline;
    if (input.selected) {
      const { adjustments, ...candidate } = input.selected;
      if (!adjustments?.length) fail("promotion_allocation_unsubstantiated", "/selected/adjustments");
      const selected = planCandidate({ ...read(candidateShape, candidate, "/selected"), adjustments }, currencyCode, lines);
      if (selected.score <= baseline.score) winner = selected;
    }
    const diagnostics = codeDiagnostics(input.codeDiagnostics, winner === baseline);
    return { kind: "planned", currency: currencyCode, price: priceFacts, lines,
      winner: winner.winner, moneyInput: winner.moneyInput, plan: winner.plan,
      promotion: { engine: input.engine, rankingRuleRef: amountBasis === "inclusive" ? "lowest_payable_gross" : "lowest_pre_tax.v1" },
      ...(diagnostics ? { codeDiagnostics: diagnostics } : {}) };
  } catch (error) { return handle(error); }
}

function componentKey(component: CatalogueMoneyV2ComponentRef): string {
  return JSON.stringify(component.kind === "merchandise"
    ? [component.kind, component.lineKey, component.sourceOrdinal] : [component.kind, component.bucketKey, component.sourceOrdinal]);
}
function allocationKey(component: CatalogueMoneyV2ComponentRef, sequence: number): string {
  return componentKey(component) + "/" + sequence;
}
function uniqueMap<T>(entries: readonly T[], key: (item: T) => string, code: Code, field: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of entries) {
    const id = key(item);
    if (result.has(id)) fail(code, field);
    result.set(id, item);
  }
  return result;
}

function exclusiveResult(input: Extract<ComposeCommerceQuoteMoneyV2Input, { verifiedMoney: CatalogueMoneyV2Result }>) {
  const { verifiedMoney, planned } = input;
  const fees = uniqueMap(read(z.array(feeLine).max(256), input.feeLines, "/feeLines"), fee => fee.feeKey,
    "money_tax_evidence_mismatch", "/feeLines");
  const feeLines = verifiedMoney.fees.map(({ feeKey, amountMinor }) => {
    const fee = fees.get(feeKey);
    if (!fee || fee.amountMinor !== amountMinor) fail("money_tax_evidence_mismatch", "/feeLines");
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
  try {
    if (canonicalCatalogDraftJson(result) !== canonicalCatalogDraftJson(verifiedMoney)) {
      fail("money_tax_evidence_mismatch", "/verifiedMoney");
    }
  } catch (error) {
    if (error instanceof MoneyRefusal) throw error;
    fail("money_tax_evidence_mismatch", "/verifiedMoney");
  }
  return { result, feeLines };
}

type ResultComponent = CatalogueMoneyV2Result["components"][number];
function positionReader(input: ComposeCommerceQuoteMoneyV2Input, result: CatalogueMoneyV2Result) {
  const remaining = "fiscal" in input
    ? uniqueMap(input.positions.map(({ ref, position }) => ({ key: componentKey(ref), position })),
      item => item.key, "money_tax_evidence_mismatch", "/positions")
    : uniqueMap(input.positions.map(position => ({ key: position.positionRef, position })),
      item => item.key, "money_tax_evidence_mismatch", "/positions");
  const all = new Map(remaining);
  const fiscalRates = "fiscal" in input
    ? new Map(input.fiscal.map(row => [componentKey(row.ref), row.rateBps])) : undefined;
  const merchandise = new Map(result.components.flatMap(({ ref }) => ref.kind === "merchandise" ? [[ref.sourceOrdinal, ref] as const] : []));
  function metadata(key: string): PositionMetadata {
    const entry = all.get(key);
    if (!entry) fail("money_tax_evidence_mismatch", "/positions");
    remaining.delete(key);
    return read(positionMetadata, entry.position, "/positions", "money_tax_evidence_mismatch");
  }
  return {
    checkUsed() { if (remaining.size) fail("money_tax_evidence_mismatch", "/positions"); },
    read(component: CatalogueMoneyV2ComponentRef, state: CatalogueMoneyV2State): TaxPositionV2[] {
      if (!fiscalRates) return state.taxPositions.map(position => {
        const facts = metadata(position.positionRef);
        if (facts.jurisdictionRef !== position.jurisdictionRef) fail("money_tax_evidence_mismatch", "/positions");
        return { ...facts, ...position };
      });
      if (state.amountMinor === 0) return [];
      const rateRef = component.kind === "delivery" && component.sourceOrdinal !== undefined
        ? merchandise.get(component.sourceOrdinal)! : component;
      const rate = fiscalRates.get(componentKey(rateRef));
      if (rate === undefined) fail("money_tax_evidence_mismatch", "/fiscal");
      return [{ ...metadata(componentKey(component)), rateDecimal: String(rate / 100),
        taxableMinor: state.netMinor, taxMinor: state.taxMinor }];
    },
  };
}

function projectComponents(input: ComposeCommerceQuoteMoneyV2Input, result: CatalogueMoneyV2Result) {
  const positions = positionReader(input, result);
  const ids = uniqueMap(input.allocationIds, row => allocationKey(row.ref, row.sequence),
    "promotion_allocation_unsubstantiated", "/allocationIds");
  function project({ ref, initial, final, allocations }: ResultComponent) {
    const state = (row: CatalogueMoneyV2State) => ({
      basisMinor: row.amountMinor, netMinor: row.netMinor, taxMinor: row.taxMinor, taxPositions: positions.read(ref, row),
    });
    const discountAllocations: DiscountAllocationV2[] = allocations.map(share => {
      const { adjustmentRef, sequence, basisReductionMinor, netReductionMinor, taxReductionMinor } = share;
      const key = allocationKey(ref, sequence);
      const supplied = ids.get(key);
      const adjustment = input.planned.winner.adjustments[sequence - 1];
      if (!supplied || adjustment?.adjustmentRef !== adjustmentRef) fail("promotion_allocation_unsubstantiated", "/allocationIds");
      ids.delete(key);
      return { allocationId: read(uuid, supplied.allocationId, "/allocationIds", "promotion_allocation_unsubstantiated"),
        adjustmentRef, sequence, basisReductionMinor, netReductionMinor, taxReductionMinor, source: "legacy_promotion",
        evidenceRef: adjustment.evidenceRef, before: state(share.before), after: state(share.after) };
    });
    return { preDiscountMinor: initial.amountMinor, effectiveMinor: final.amountMinor, discountAllocations,
      netMinor: final.netMinor, taxMinor: final.taxMinor, lineTotalMinor: final.totalMinor, taxPositions: positions.read(ref, final) };
  }
  const lines: MoneyLineV2[] = [];
  const sources = new Map(input.planned.lines.map(source => [source.lineKey, source]));
  const parts = new Map<string, DeliveryBucketV2["parts"][number][]>();
  for (const component of result.components) {
    const { ref } = component;
    const money = project(component);
    if (ref.kind === "merchandise") {
      const source = sources.get(ref.lineKey);
      if (!source || source.sourceOrdinal !== ref.sourceOrdinal) fail("money_tax_evidence_mismatch", "/lines");
      const { amountKind: _amountKind, ...line } = source;
      lines.push({ ...line, ...money });
    } else {
      const bucket = parts.get(ref.bucketKey) ?? [];
      bucket.push({ ...money, ...(ref.sourceOrdinal === undefined ? {} : { sourceOrdinal: ref.sourceOrdinal }) });
      parts.set(ref.bucketKey, bucket);
    }
  }
  const deliveryBuckets = input.planned.winner.delivery.map(({ threshold: _threshold, amountMinor: _amount, ...bucket }) => {
    const found = parts.get(bucket.bucketKey);
    if (!found) fail("money_tax_evidence_mismatch", "/deliveryBuckets");
    return { ...bucket, parts: found };
  });
  positions.checkUsed();
  if (ids.size) fail("promotion_allocation_unsubstantiated", "/allocationIds");
  return { lines, deliveryBuckets };
}

/** @experimental Assemble digest-bound money from a plan and its resolved tax evidence. */
export function composeCommerceQuoteMoneyV2(input: ComposeCommerceQuoteMoneyV2Input):
  Readonly<{ kind: "composed"; money: Body; moneyDigest: string; codeDiagnostics?: CodeDiagnostics }> | CommerceQuoteMoneyV2Refusal {
  try {
    const { planned, taxEvidence } = input;
    if ((planned.moneyInput.amountBasis === "inclusive") !== ("fiscal" in input)
      || (taxEvidence.kind === "fiscal_profile") !== ("fiscal" in input)) fail("money_amount_basis_mixed", "/amountBasis");
    const { result, feeLines } = "fiscal" in input
      ? { result: calculateCatalogueMoneyV2(planned.moneyInput, { kind: "inclusive", components: input.fiscal }),
        feeLines: planned.winner.feeLines }
      : exclusiveResult(input);
    const { amountBasis, netTotal, taxTotal, feeTotal, payableMinor } = result;
    const money = read(moneyShape, { ...input.facts, ...projectComponents(input, result), feeLines, amountBasis,
      netTotal, taxTotal, feeTotal, payableMinor, taxEvidence, price: planned.price, currency: planned.currency,
      deliverySelectionRef: planned.winner.deliverySelectionRef, promotion: planned.promotion }, "");
    const issue = checkMoney(money);
    if (issue) fail(issue.code, pointer(issue.path));
    let moneyDigest: string;
    try { moneyDigest = quoteDigest("commerce.quote-money.v2", money); }
    catch { return fail("money_input_invalid", ""); }
    return { kind: "composed", money, moneyDigest,
      ...(planned.codeDiagnostics ? { codeDiagnostics: planned.codeDiagnostics } : {}) };
  } catch (error) { return handle(error, "fiscal" in input ? "/fiscal" : "/verifiedMoney"); }
}
