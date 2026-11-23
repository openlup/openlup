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
import { quoteDigest } from "./quoteDigest.js";
import { absentFeeBucket, bucketSource, checkDocumentSize, checkMoney, currency, engine, feeLine, inputData,
  inputField, lineSource, minor, MoneyIssue, moneyRef, moneyShape, positionMetadata, price, ref, remedies,
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
type RateRows = Extract<CatalogueMoneyV2Tax, { kind: "inclusive" }>["components"];

/** @experimental Resolved list-basis prices, owner adjustments and delivery alternatives. Supply the owner’s applied codes and the original submitted codes. */
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
    const [, component, , state, key, ...rest] = tail;
    const at = ["verifiedMoney", "components", component].filter(key => key !== undefined);
    if (!state) return new MoneyIssue(code, tail[0] === "payableMinor" ? ["verifiedMoney", "payableMinor"]
      : [...at, ...tail.slice(2).map(key => key === "states" ? "allocations" : key)]);
    const statePath = state === "0" ? ["initial"] : ["allocations", Number(state) - 1, "after"];
    return new MoneyIssue(code, key === "afterSequence" ? [...at, "allocations", Number(state) - 1, "sequence"]
      : [...at, ...statePath, ...(key ? [key, ...rest] : [])]);
  }
  const names: Record<string, string> = { sources: "lines", fees: "feeLines", deliveryKind: "kind",
    preDiscountMinor: "unitBasisMinor", amountMinor: group === "adjustments" ? "amountOffMinor" : "amountMinor" };
  const parts = [group, ...tail].map(key => planning ? names[key] ?? key : key);
  if (planning) return new MoneyIssue(code, group === "sources" ? parts : group === "input" ? segments(scope) : [...segments(scope), ...parts]);
  if (group.endsWith("Total") || group === "payableMinor") return new MoneyIssue(code, ["facts", "paymentLimits", "maxMinor"]);
  const prefix = scope === "/verifiedMoney" && group === "fees" ? ["verifiedMoney"] : ["planned", "moneyInput"];
  return new MoneyIssue(code, [...prefix, ...parts]);
}

function refusal(error: unknown, input: unknown, scope: string, planning = false): CommerceQuoteMoneyV2Refusal {
  const issue = error instanceof MoneyIssue ? error : error instanceof CatalogueMoneyV2Error ? coreIssue(error, scope, planning)
    : new MoneyIssue("money_input_invalid", segments(scope));
  return { kind: "refused", code: issue.code, field: inputField(input, issue.path, planning ? "currency" : "planned"), remedy: issue.remedy };
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

function codeDiagnostics(input: PlanCommerceQuoteMoneyV2Input["codeDiagnostics"], baselineWins: boolean): CodeDiagnostics | undefined {
  if (!input) return undefined;
  const { appliedCodes, submittedCodes, codeRejections, codeRejectionDetails } = input;
  if (!baselineWins || !appliedCodes.length) return { codeRejections, codeRejectionDetails };
  const rejected = new Set(codeRejections.map(row => row.code));
  const identity = (code: string) => code.trim().toUpperCase();
  const displaced = [...new Set(appliedCodes.map(code =>
    submittedCodes.find(submitted => !rejected.has(submitted) && identity(submitted) === identity(code)) ?? code))]
    .filter(code => !rejected.has(code));
  const ranks = new Map(submittedCodes.map((code, index) => [code, index] as const).reverse());
  const rank = (code: string) => ranks.get(code) ?? submittedCodes.length;
  const amended = [...codeRejections];
  for (const code of displaced.sort((left, right) => rank(left) - rank(right))) {
    const next = amended.findIndex(row => rank(row.code) > rank(code));
    amended.splice(next < 0 ? amended.length : next, 0, { code, reason: "better_price_exists" });
  }
  return { codeRejections: amended, codeRejectionDetails };
}

/** @experimental Rank the supplied owner outcome and the no-adjustment baseline on their list basis. */
export function planCommerceQuoteMoneyV2(input: PlanCommerceQuoteMoneyV2Input): CommerceQuoteMoneyV2Plan | CommerceQuoteMoneyV2Refusal {
  let scope = "/baseline";
  try {
    input = inputData(input, "currency");
    const currencyCode = read(currency, input.currency, "/currency");
    read(engine, input.engine, "/engine");
    const priceFacts = read(price, input.price, "/price");
    const lines = read(z.array(sourceShape).min(1).max(50), input.lines, "/lines");
    const amountBasis = read(basis.nullable(), input.listBasis, "/listBasis") ?? "inclusive";
    const mixed = lines.findIndex(line => line.amountKind !== (amountBasis === "inclusive" ? "gross" : "net"));
    if (mixed !== -1) fail("money_amount_basis_mixed", "/lines/" + mixed + "/amountKind");
    const baseline = planCandidate({ ...read(candidateShape, input.baseline, scope), adjustments: [] }, currencyCode, lines, scope, amountBasis);
    let winner = baseline;
    if (input.selected !== undefined) {
      scope = "/selected";
      const { adjustments, ...candidate } = read(candidateShape.extend({ adjustments: z.array(z.unknown()) }), input.selected, scope);
      const applied = read(z.array(adjustmentShape).min(1).max(20), adjustments, "/selected/adjustments", "promotion_allocation_unsubstantiated");
      const selected = planCandidate({ ...candidate, adjustments: applied }, currencyCode, lines, scope, amountBasis);
      if (selected.score <= baseline.score) winner = selected;
    }
    const diagnostics = codeDiagnostics(input.codeDiagnostics, winner === baseline);
    return { kind: "planned", currency: currencyCode, price: priceFacts, lines,
      winner: winner.winner, moneyInput: winner.moneyInput, plan: winner.plan,
      promotion: { engine: input.engine, rankingRuleRef: amountBasis === "inclusive" ? "lowest_payable_gross" : "lowest_pre_tax.v1" },
      ...(diagnostics ? { codeDiagnostics: diagnostics } : {}) };
  } catch (error) { return refusal(error, input, scope, true); }
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
  for (const [index, item] of entries.entries()) {
    const id = key(item);
    if (result.has(id)) fail(code, field + "/" + index);
    result.set(id, item);
  }
  return result;
}

function exclusiveResult(input: Extract<ComposeCommerceQuoteMoneyV2Input, { verifiedMoney: CatalogueMoneyV2Result }>) {
  const { verifiedMoney, planned } = input;
  checkDocumentSize(verifiedMoney, 0, ["verifiedMoney"]);
  const fees = uniqueMap(read(z.array(feeLine).max(256), input.feeLines, "/feeLines"), fee => fee.feeKey,
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

type ResultComponent = CatalogueMoneyV2Result["components"][number];
function positionReader(input: ComposeCommerceQuoteMoneyV2Input, result: CatalogueMoneyV2Result) {
  const entries = input.positions.map((row, index) => {
    const position = "position" in row ? row.position : row;
    const field = "/positions/" + index + ("position" in row ? "/position" : "");
    return { index, key: "ref" in row ? componentKey(row.ref) : row.positionRef,
      position: read(positionMetadata, position, field, "money_tax_evidence_mismatch") };
  });
  const remaining = uniqueMap(entries, entry => entry.key, "money_tax_evidence_mismatch", "/positions");
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
      return { allocationId: read(uuid, supplied.allocationId, "/allocationIds/" + input.allocationIds.indexOf(supplied) + "/allocationId", "promotion_allocation_unsubstantiated"),
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
      if (!source || source.sourceOrdinal !== ref.sourceOrdinal) fail("money_tax_evidence_mismatch", "/planned/lines");
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
    if (!found) fail("money_tax_evidence_mismatch", "/planned/winner/delivery");
    return { ...bucket, parts: found };
  });
  positions.checkUsed();
  if (ids.size) fail("promotion_allocation_unsubstantiated", "/allocationIds");
  return { lines, deliveryBuckets };
}

function compositionPath(input: ComposeCommerceQuoteMoneyV2Input, money: Body, path: Path): Path {
  const [root, index, ...tail] = path;
  if (root === "price" || root === "currency" || root === "promotion") return ["planned", ...path];
  if (root === "deliverySelectionRef") return ["planned", "winner", root];
  if (root === "payableMinor") return ["facts", "paymentLimits", money.payableMinor > input.facts.paymentLimits.maxMinor ? "maxMinor" : "minMinor"];
  if (root === "feeLines") {
    if ("fiscal" in input) return ["planned", "winner", ...path];
    const feeIndex = input.feeLines.findIndex(fee => fee.feeKey === money.feeLines[Number(index)]?.feeKey);
    return feeIndex < 0 ? ["feeLines"] : ["feeLines", feeIndex, ...tail];
  }
  if (root !== "lines" && root !== "deliveryBuckets") return root === "taxEvidence" ? path : ["facts", ...path];
  const line = root === "lines" ? money.lines[Number(index)] : undefined;
  const bucket = root === "deliveryBuckets" ? money.deliveryBuckets[Number(index)] : undefined;
  const component = line ?? bucket?.parts[Number(tail[1])];
  const shareIndex = tail.indexOf("discountAllocations");
  const share = shareIndex < 0 ? undefined : component?.discountAllocations[Number(tail[shareIndex + 1])];
  const taxIndex = tail.indexOf("taxPositions");
  const matches = (ref: CatalogueMoneyV2ComponentRef) => ref.kind === "merchandise" ? ref.lineKey === line?.lineKey
    : ref.bucketKey === bucket?.bucketKey && ref.sourceOrdinal === (component && "sourceOrdinal" in component ? component.sourceOrdinal : undefined);
  if (taxIndex >= 0) {
    if ("fiscal" in input) {
      const row = input.positions.findIndex(({ ref }) => matches(ref));
      return row < 0 ? ["positions"] : ["positions", row, "position"];
    }
    const row = input.verifiedMoney.components.findIndex(({ ref }) => matches(ref));
    const statePath = share ? ["allocations", Number(tail[shareIndex + 1]), tail[shareIndex + 2]] : ["final"];
    return ["verifiedMoney", "components", row, ...statePath, ...tail.slice(taxIndex)];
  }
  if (shareIndex >= 0) {
    const id = input.allocationIds.findIndex(row => row.allocationId === share?.allocationId && matches(row.ref));
    return id < 0 ? ["allocationIds"] : ["allocationIds", id, "allocationId"];
  }
  return line ? ["planned", "lines", input.planned.lines.findIndex(source => source.lineKey === line.lineKey), ...tail]
    : ["planned", "winner", "delivery", index, ...tail.slice(0, tail[0] === "parts" ? 0 : tail.length)];
}

const record = z.record(z.string(), z.unknown());
const compositionShape = z.looseObject({
  planned: z.looseObject({ moneyInput: record, winner: record }), facts: record,
  taxEvidence: z.looseObject({ kind: z.enum(["fiscal_profile", "tax_calculation"]) }),
  allocationIds: z.array(record), positions: z.array(record),
});
/** @experimental Assemble digest-bound money from a plan and its resolved tax evidence. */
export function composeCommerceQuoteMoneyV2(input: ComposeCommerceQuoteMoneyV2Input):
  Readonly<{ kind: "composed"; money: Body; moneyDigest: string; codeDiagnostics?: CodeDiagnostics }> | CommerceQuoteMoneyV2Refusal {
  let scope = "/planned";
  try {
    const admitted = inputData(input, "planned");
    read(compositionShape, admitted, "");
    const { planned, taxEvidence } = admitted;
    const fiscal = "fiscal" in admitted;
    scope = fiscal ? "/fiscal" : "/verifiedMoney";
    if (!fiscal && taxEvidence.kind === "fiscal_profile" && !("verifiedMoney" in admitted)) fail("money_input_invalid", "/fiscal");
    read<unknown>(fiscal ? z.array(record) : record, fiscal ? admitted.fiscal : admitted.verifiedMoney, scope);
    if ((planned.moneyInput.amountBasis === "inclusive") !== fiscal) fail("money_amount_basis_mixed", "/planned/moneyInput/amountBasis");
    if ((taxEvidence.kind === "fiscal_profile") !== fiscal) fail("money_amount_basis_mixed", "/taxEvidence/kind");
    const { result, feeLines } = fiscal
      ? { result: calculateCatalogueMoneyV2(planned.moneyInput, { kind: "inclusive", components: admitted.fiscal }),
        feeLines: planned.winner.feeLines }
      : exclusiveResult(admitted);
    const { amountBasis, netTotal, taxTotal, feeTotal, payableMinor } = result;
    const projected = { ...admitted.facts, ...projectComponents(admitted, result), feeLines, amountBasis,
      netTotal, taxTotal, feeTotal, payableMinor, taxEvidence, price: planned.price, currency: planned.currency,
      deliverySelectionRef: planned.winner.deliverySelectionRef, promotion: planned.promotion } as Body;
    try {
      const money = read(moneyShape, projected, "");
      const issue = checkMoney(money);
      if (issue) throw issue;
      checkDocumentSize(money, 28);
      return { kind: "composed", money, moneyDigest: quoteDigest("commerce.quote-money.v2", money),
        ...(planned.codeDiagnostics ? { codeDiagnostics: planned.codeDiagnostics } : {}) };
    } catch (error) {
      if (!(error instanceof MoneyIssue)) throw error;
      throw new MoneyIssue(error.code, compositionPath(admitted, projected, error.path), error.remedy);
    }
  } catch (error) { return refusal(error, input, scope); }
}
