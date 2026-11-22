import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error } from "@openlup/core/pricing";
import type { CatalogueMoneyV2ComponentRef, CatalogueMoneyV2Result, CatalogueMoneyV2State } from "@openlup/core/pricing";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import { array, bounded, checked, exclusiveTaxRemedy, invalid, object, oneOf, taxReferenceRemedy, variant } from "./contracts/decode.js";
import { cellKey, compareCells, compareDeclarations, decisionIsPossible, declarationKey, effectiveDeclarations, permitsAssessment, sameCell } from "./contracts/identity.js";
import {
  coverageAccountMatches, isTaxDigest, parseQuoteKey, quoteEvidenceSchema, quoteInputSchema,
  taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema,
} from "./contracts/schemas.js";
import type {
  TaxCalculationEvidenceV1, TaxFiscalValidityRequestV1, TaxQuoteInputV1, TaxQuoteRequestV1, TaxQuoteResultV1, TaxRefusal,
} from "./contracts/index.js";

type DigestTag = "input" | "coverage" | "fiscal" | "resolution" | "evidence" | "rate-table" | "close" | "commit" | "reverse";

export function taxDigest(tag: DigestTag, payload: unknown): string {
  try {
    const canonical = canonicalCatalogDraftJson(["platform.tax." + tag + ".v1", payload]);
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    return invalid("", "Supply a canonical document of at most one MiB including its digest tag.");
  }
}

function normalize(input: TaxQuoteInputV1): TaxQuoteInputV1 {
  return {
    ...input,
    required: [...input.required].sort(compareCells),
    coverage: { ...input.coverage, declarations: [...input.coverage.declarations].sort(compareDeclarations) },
  };
}

export function makeTaxQuoteRequest(key: string, input: TaxQuoteInputV1): TaxQuoteRequestV1 {
  const parsedKey = parseQuoteKey(key);
  const normalized = normalize(quoteInputSchema.parse(input));
  return bounded({ key: parsedKey, input: normalized, inputDigest: taxDigest("input", normalized) });
}

const remedies = {
  tax_reference_conflict: taxReferenceRemedy,
  tax_invalid_input: "Supply the documented value at the indicated field.",
  tax_amount_out_of_range: "Supply amounts within the supported safe-integer range, including the combined basis of all components.",
  tax_scope_mismatch: exclusiveTaxRemedy,
  tax_calculation_unusable: "Obtain calculation evidence for the original request with coverage supported by effective observations.",
  tax_breakdown_incomplete: "Recover and replay the complete original calculation breakdown for the intended request and key.",
} as const;

type VerifierCode = keyof typeof remedies;
export function refuseVerification(code: VerifierCode, field: string): TaxRefusal {
  return { kind: "refused", code, field, remedy: remedies[code] };
}

function decodeRefusal(error: unknown, root = ""): TaxRefusal {
  if (error instanceof Error && "field" in error && typeof error.field === "string"
    && "code" in error && typeof error.code === "string" && Object.hasOwn(remedies, error.code)) {
    return refuseVerification(error.code as VerifierCode, root + error.field);
  }
  return refuseVerification("tax_invalid_input", root);
}

function referenceConflict(field: string): never {
  return invalid(field, remedies.tax_reference_conflict, "tax_reference_conflict");
}

function snapshotDocument<T>(document: T, field = ""): T {
  try { return JSON.parse(canonicalCatalogDraftJson(document)) as T; }
  catch { return referenceConflict(field); }
}

function withSnapshot<T, R>(document: T, verify: (snapshot: T) => R): R | TaxRefusal {
  try { return verify(snapshotDocument(document)); }
  catch (error) { return decodeRefusal(error); }
}

function checkDigest<T>(tag: DigestTag, payload: () => T, anchor: unknown, field: string): T {
  if (!isTaxDigest(anchor)) referenceConflict(field);
  let actual: string;
  let document: T;
  try {
    document = payload();
    actual = taxDigest(tag, document);
  } catch { return referenceConflict(field); }
  if (actual !== anchor) referenceConflict(field);
  return document;
}

function compareBinding(actual: unknown, expected: unknown, field: string): void {
  if (typeof actual !== "string" || actual !== expected) referenceConflict(field);
}

const scopeKeys = ["adapter", "adapterVersion", "accountRef", "mode"] as const;
function compareScope(actual: TaxQuoteInputV1["scope"], original: TaxQuoteInputV1["scope"], field: string, origin: string): void {
  if (!actual) referenceConflict(field);
  if (!original) referenceConflict(origin);
  if (scopeKeys.some(key => typeof actual[key] === "string" && typeof original[key] === "string" && actual[key] !== original[key])) {
    referenceConflict(field);
  }
  for (const key of scopeKeys) {
    if (typeof actual[key] !== "string") referenceConflict(field + "/" + key);
    if (typeof original[key] !== "string") referenceConflict(origin + "/" + key);
  }
}

type FiscalEvidence = Pick<TaxCalculationEvidenceV1,
  "scope" | "destinationDigest" | "shipFromRef" | "policyRevision" | "classMapRevision" | "coverage" | "positions">;

function fiscalPayload({ scope, destinationDigest, shipFromRef, policyRevision, classMapRevision, coverage, positions }: FiscalEvidence) {
  const tax = positions.tax.map(({ resolutionDigest: _digest, providerLineRef: _providerRef, ...row }) => row);
  return { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision,
    coverage: coverage.vector, tax, fees: positions.fees };
}

export const taxFiscalDigest = (evidence: FiscalEvidence): string => taxDigest("fiscal", fiscalPayload(evidence));

type EvidenceEnvelope = { evidence?: TaxCalculationEvidenceV1; evidenceDigest?: string };
function checkEvidenceDigests({ evidence, evidenceDigest }: EvidenceEnvelope): TaxCalculationEvidenceV1 {
  if (!evidence || !isTaxDigest(evidenceDigest)) referenceConflict("/evidenceDigest");
  if (!Array.isArray(evidence.positions?.tax)) referenceConflict("/evidence/positions/tax");
  for (const [index, row] of evidence.positions.tax.entries()) {
    const field = "/evidence/positions/tax/" + index;
    checkDigest("resolution", () => row?.resolution ?? undefined, row?.resolutionDigest, field + "/resolutionDigest");
    const source = row.resolution?.sourceDigest;
    if (source !== undefined && !isTaxDigest(source)) referenceConflict(field + "/resolution/sourceDigest");
  }
  checkDigest("coverage", () => evidence.coverage?.vector ?? undefined, evidence.coverage?.digest, "/evidence/coverage/digest");
  checkDigest("fiscal", () => fiscalPayload(evidence), evidence.fiscalDigest, "/evidence/fiscalDigest");
  checkDigest("evidence", () => evidence, evidenceDigest, "/evidenceDigest");
  return evidence;
}

function compareCoverage(input: TaxQuoteInputV1, evidence: TaxCalculationEvidenceV1): void {
  const { vector } = evidence.coverage;
  const field = "/evidence/coverage/vector";
  if (vector.length !== input.required.length || vector.some((row, index) =>
    !row?.cell || canonicalCatalogDraftJson(row.cell) !== canonicalCatalogDraftJson(input.required[index]))) referenceConflict(field);

  const declarations = effectiveDeclarations(input.coverage.declarations, input.taxDate);
  for (const [index, { cell, declaration }] of vector.entries()) {
    const expected = declarations.get(declarationKey(cell));
    if (canonicalCatalogDraftJson([declaration ?? null]) !== canonicalCatalogDraftJson([expected ?? null])) {
      referenceConflict(field + "/" + index + "/declaration");
    }
  }
}

function verifyIntegrity(
  request: TaxQuoteRequestV1, context: { fiscal?: TaxFiscalValidityRequestV1; result?: TaxQuoteResultV1 } = {},
): void {
  const { fiscal, result } = context;
  const root = fiscal ? "/original" : "";
  if ((!request || typeof request !== "object") && !fiscal) return;
  const input = request?.input;
  if ((input?.scope || input?.coverage) && !coverageAccountMatches(input)) referenceConflict(root + "/input/coverage/accountRef");
  const normalized = checkDigest("input", () => normalize(input), request?.inputDigest, root + "/inputDigest");
  if (typeof request.key !== "string") referenceConflict(root + "/key");
  if (!isTaxDigest(input.destination?.digest)) referenceConflict(root + "/input/destination/digest");

  const quote = result && typeof result === "object" && result.kind !== "refused" && result.kind !== "unavailable" ? result : undefined;
  const verifyKind = () => {
    if (quote) compareBinding(quote.kind, input.purpose, "/kind");
  };
  const envelope = fiscal ?? quote;
  if (!envelope) return;
  if (!envelope.evidence) verifyKind();
  const evidence = checkEvidenceDigests(envelope);
  compareBinding(evidence.inputDigest, request.inputDigest, "/evidence/inputDigest");
  compareBinding(evidence.requestKey, request.key, "/evidence/requestKey");
  compareBinding(evidence.destinationDigest, input.destination.digest, "/evidence/destinationDigest");
  compareScope(evidence.scope, input.scope, "/evidence/scope", root + "/input/scope");
  compareBinding(evidence.status, input.purpose, "/evidence/status");
  verifyKind();
  for (const key of ["taxDate", "shipFromRef", "policyRevision", "classMapRevision"] as const) {
    compareBinding(evidence[key], input[key], "/evidence/" + key);
  }
  if (fiscal) {
    if (!isTaxDigest(fiscal.current?.destination?.digest)) referenceConflict("/current/destination/digest");
    if (!coverageAccountMatches(fiscal.current)) referenceConflict("/current/coverage/accountRef");
    compareScope(fiscal.current.scope, input.scope, "/current/scope", "/original/input/scope");
  }
  compareCoverage(normalized, evidence);
}

function verifyEvidenceMetadata(
  request: TaxQuoteRequestV1, evidence: TaxCalculationEvidenceV1, assessments?: readonly Located[],
): TaxRefusal | undefined {
  const input = request.input;
  const { vector } = evidence.coverage;
  const impossible = vector.findIndex(row => !decisionIsPossible(row));
  if (impossible >= 0) return refuseVerification("tax_calculation_unusable", "/evidence/coverage/vector/" + impossible + "/decision");
  const coverage = new Map(vector.map(row => [cellKey(row.cell), row]));
  const lines = new Map(input.lines.map(item => [item.lineKey, item.assignmentRef]));
  const buckets = new Map(input.delivery.map(item => [item.bucketKey, item.assignmentRef]));
  const positionBinding = (row: TaxCalculationEvidenceV1["positions"]["tax"][number], cell: Cell): string | undefined => {
    const { target } = cell;
    const assignment = (target.kind === "line" ? lines : buckets).get(target.key);
    if (assignment !== row.resolution.assignmentRef) return "/resolution/assignmentRef";
    if (row.resolution.policyRevision !== evidence.policyRevision) return "/resolution/policyRevision";
    const treatment = coverage.get(cellKey(cell))?.treatment;
    if (treatment && row.ruleRef !== treatment.ruleRef) return "/ruleRef";
  };
  const mismatch = assessments && verifyAssessments(assessments, evidence, coverage, positionBinding);
  if (mismatch) return mismatch;

  const providerLines = evidence.providerLines && new Map(evidence.providerLines.map(row => [row.lineKey, row.providerLineRef]));
  if (providerLines && (providerLines.size !== lines.size || [...lines.keys()].some(key => !providerLines.has(key)))) {
    return refuseVerification("tax_reference_conflict", "/evidence/providerLines");
  }
  for (const [index, row] of evidence.positions.tax.entries()) {
    const { target } = row.cell;
    const path = "/evidence/positions/tax/" + index;
    if (providerLines && target.kind === "line" && row.providerLineRef !== undefined && row.providerLineRef !== providerLines.get(target.key)) {
      return refuseVerification("tax_reference_conflict", path + "/providerLineRef");
    }
    const field = positionBinding(row, row.cell);
    if (field) return refuseVerification("tax_reference_conflict", path + field);
  }
}

function parseQuoteRequest(request: TaxQuoteRequestV1): TaxQuoteRequestV1 {
  verifyIntegrity(request);
  return taxQuoteRequestV1Schema.parse(request);
}

function parseFiscalValidity(request: TaxFiscalValidityRequestV1): TaxFiscalValidityRequestV1 | TaxRefusal {
  verifyIntegrity(request.original, { fiscal: request });
  const parsed = taxFiscalValidityRequestV1Schema.parse(request);
  return verifyEvidenceMetadata(parsed.original, parsed.evidence) ?? parsed;
}

export function checkedQuoteRequest(request: TaxQuoteRequestV1): TaxQuoteRequestV1 | TaxRefusal {
  return withSnapshot(request, parseQuoteRequest);
}

export function checkedFiscalValidity(request: TaxFiscalValidityRequestV1): TaxFiscalValidityRequestV1 | TaxRefusal {
  return withSnapshot(request, parseFiscalValidity);
}

/** Verify quote or fiscal-validity integrity before input validation and reconciliation. */
export function verifyTaxQuoteRequest(request: TaxQuoteRequestV1 | TaxFiscalValidityRequestV1): TaxRefusal | undefined {
  const checked = withSnapshot(request, snapshot => snapshot && Object.hasOwn(snapshot, "original")
    ? parseFiscalValidity(snapshot as TaxFiscalValidityRequestV1) : parseQuoteRequest(snapshot as TaxQuoteRequestV1));
  if ("kind" in checked) return checked;
}

function firstDifference(expected: unknown, actual: unknown, path: string): string | undefined {
  if (isDeepStrictEqual(expected, actual)) return;
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object"
    || Array.isArray(expected) !== Array.isArray(actual)) return path;
  const left = expected as Record<string, unknown>, right = actual as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const child = path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1");
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return child;
    const differing = firstDifference(left[key], right[key], child);
    if (differing) return differing;
  }
  return path;
}

function statePath(index: number): string {
  return index === 0 ? "initial" : "allocations/" + (index - 1) + "/after";
}

function moneyField(field: string): string {
  return "/money/" + field.replace(/^tax\./, "")
    .replace(/\.states\[(\d+)\]\.afterSequence$/, (_match, index: string) => ".allocations/" + (Number(index) - 1) + "/sequence")
    .replace(/\.states\[(\d+)\]/, (_match, index: string) => "." + statePath(Number(index)))
    .replace(/\.states$/, ".allocations").replace(/\[(\d+)\]/g, ".$1").replaceAll(".", "/");
}

function verifyMoney(input: TaxQuoteInputV1["money"], money: CatalogueMoneyV2Result): TaxRefusal | undefined {
  if (money.amountBasis === "inclusive") return refuseVerification("tax_scope_mismatch", "/money/amountBasis");
  const state = (value: CatalogueMoneyV2State, afterSequence: number) =>
    ({ afterSequence, amountMinor: value.amountMinor, taxPositions: value.taxPositions });
  try {
    const recomputed = calculateCatalogueMoneyV2({ ...input, fees: money.fees }, {
      kind: "provider", payableMinor: money.payableMinor,
      components: money.components.map(({ ref, initial, allocations }) => ({
        ref, states: [state(initial, 0), ...allocations.map(row => state(row.after, row.sequence))],
      })),
    });
    const field = firstDifference(recomputed, money, "/money");
    if (field) return refuseVerification("tax_breakdown_incomplete", field);
  } catch (error) {
    if (!(error instanceof CatalogueMoneyV2Error)) throw error;
    return refuseVerification("tax_breakdown_incomplete", moneyField(error.field));
  }
}

type Cell = TaxQuoteInputV1["required"][number];
type Row = TaxCalculationEvidenceV1["coverage"]["vector"][number];
type Assessment = { id: string; minor: number; path: string } & (
  { kind: "tax"; rate?: string } | { kind: "fee" }
);
type Located = { assessment: Assessment; candidates: readonly Cell[] };

const assessmentRef = (item: Assessment) => item.path + (item.kind === "tax" ? "/positionRef" : "/feeKey");
const cellCoordinates = ({ target, jurisdiction }: Cell) =>
  JSON.stringify(target.kind === "fee" ? [target.kind, target.key] : [target.kind, target.key, jurisdiction]);

function collectAssessments(input: TaxQuoteInputV1, money: CatalogueMoneyV2Result): readonly Located[] | TaxRefusal {
  const required = new Map<string, Cell[]>();
  for (const cell of input.required) {
    const key = cellCoordinates(cell);
    const list = required.get(key);
    if (list) list.push(cell);
    else required.set(key, [cell]);
  }
  const rows: Located[] = [];
  const identities = new Map<string, string>();
  for (const [index, { ref, initial, allocations }] of money.components.entries()) {
    const [target, key] = ref.kind === "merchandise" ? ["line", ref.lineKey] as const : ["delivery", ref.bucketKey] as const;
    // Recomputed equality also binds the mirrored before and final states.
    for (const [stateIndex, state] of [initial, ...allocations.map(row => row.after)].entries()) {
      for (const [positionIndex, position] of state.taxPositions.entries()) {
        const path = "/money/components/" + index + "/" + statePath(stateIndex) + "/taxPositions/" + positionIndex;
        const { positionRef: id, jurisdictionRef: jurisdiction, rateDecimal: rate, taxMinor: minor } = position;
        const coordinates = JSON.stringify([target, key, jurisdiction]);
        const fingerprint = JSON.stringify([coordinates, rate]);
        if (identities.has(id) && identities.get(id) !== fingerprint) {
          return refuseVerification("tax_breakdown_incomplete", path + "/positionRef");
        }
        const candidates = required.get(coordinates);
        if (!candidates) return refuseVerification("tax_breakdown_incomplete", path + "/jurisdictionRef");
        identities.set(id, fingerprint);
        rows.push({ assessment: { kind: "tax", id, minor, path, rate }, candidates });
      }
    }
  }
  for (const [index, { feeKey: id, amountMinor: minor }] of money.fees.entries()) {
    const path = "/money/fees/" + index;
    const candidates = required.get(JSON.stringify(["fee", id]));
    if (!candidates) return refuseVerification("tax_breakdown_incomplete", path + "/feeKey");
    rows.push({ assessment: { kind: "fee", id, minor, path }, candidates });
  }
  return rows;
}

function metadataPointer(actual: Record<string, unknown>, required: Record<string, unknown>, path: string): string {
  const fields = Object.keys(required).filter(key => !isDeepStrictEqual(actual[key], required[key]));
  return fields.length === 1 ? path + "/" + fields[0] : path;
}

function feeCellValues({ jurisdiction, feeKind, scope }: TaxCalculationEvidenceV1["positions"]["fees"][number]) {
  return { jurisdiction, feeKind, scope };
}

function feeCell(cell: Cell) {
  return {
    jurisdiction: cell.jurisdiction, feeKind: cell.taxKind,
    scope: cell.target.kind === "fee" && cell.target.deliveryKey !== undefined
      ? { kind: "delivery", key: cell.target.deliveryKey } : { kind: "order" },
  };
}

function verifyAssessments(
  rows: readonly Located[], evidence: TaxCalculationEvidenceV1, coverage: ReadonlyMap<string, Row>,
  positionBinding: (row: TaxCalculationEvidenceV1["positions"]["tax"][number], cell: Cell) => string | undefined,
): TaxRefusal | undefined {
  type Positions = TaxCalculationEvidenceV1["positions"];
  type Entry = { path: string } & ({ kind: "tax"; row: Positions["tax"][number] } | { kind: "fee"; row: Positions["fees"][number] });
  const metadata = new Map<string, Entry>([
    ...evidence.positions.tax.map((row, index) => ["tax:" + row.positionRef, { kind: "tax", row, path: "/evidence/positions/tax/" + index }] as const),
    ...evidence.positions.fees.map((row, index) => ["fee:" + row.feeKey, { kind: "fee", row, path: "/evidence/positions/fees/" + index }] as const),
  ]);
  const used = new Set<string>();
  for (const { assessment, candidates } of rows) {
    const { kind, id, minor, path } = assessment;
    const tag = kind + ":" + id;
    const entry = metadata.get(tag);
    const decision = (candidate: Cell) => coverage.get(cellKey(candidate))!.decision;
    const admissible = candidates.filter(candidate => permitsAssessment(kind, decision(candidate), minor));
    const cell = entry?.kind === "tax" ? candidates.find(candidate => sameCell(candidate, entry.row.cell))
      : entry && candidates.find(candidate => isDeepStrictEqual(feeCell(candidate), feeCellValues(entry.row)));

    // A matched cell governs its amount. An unmatched row can still identify the assessment's failing amount or identity.
    if (cell ? !permitsAssessment(kind, decision(cell), minor) : !admissible.length) {
      const canBeZero = minor > 0 && (cell ? [cell] : candidates).some(row => permitsAssessment(kind, decision(row), 0));
      return refuseVerification("tax_breakdown_incomplete", canBeZero
        ? path + (kind === "tax" ? "/taxMinor" : "/amountMinor") : assessmentRef(assessment));
    }
    if (!entry) return refuseVerification("tax_breakdown_incomplete", assessmentRef(assessment));
    if (!cell) {
      const [candidate] = admissible;
      if (entry.kind === "tax") {
        const pointer = entry.path + "/cell";
        if (admissible.length !== 1) return refuseVerification("tax_breakdown_incomplete", pointer);
        if (positionBinding(entry.row, candidate) || (assessment.kind === "tax" && entry.row.ratePercent !== assessment.rate)) {
          return refuseVerification("tax_breakdown_incomplete", entry.path);
        }
        return refuseVerification("tax_breakdown_incomplete", metadataPointer(entry.row.cell, candidate, pointer));
      }
      return refuseVerification("tax_breakdown_incomplete", admissible.length === 1
        ? metadataPointer(feeCellValues(entry.row), feeCell(candidate), entry.path) : entry.path);
    }
    if (entry.kind === "tax" && assessment.kind === "tax" && entry.row.ratePercent !== assessment.rate) {
      return refuseVerification("tax_breakdown_incomplete", entry.path + "/ratePercent");
    }
    used.add(tag);
  }

  for (const [key, { kind, path }] of metadata) {
    if (!used.has(key)) return refuseVerification("tax_breakdown_incomplete", path + (kind === "tax" ? "/positionRef" : "/feeKey"));
  }
}

const integer = checked((value): value is number => Number.isSafeInteger(value), "Supply a safe integer.");
const text = checked((value): value is string => typeof value === "string", "Supply a string.");
const componentRef = variant<CatalogueMoneyV2ComponentRef>("kind", {
  merchandise: object({ kind: oneOf("merchandise"), lineKey: text, sourceOrdinal: integer }),
  delivery: object({ kind: oneOf("delivery"), bucketKey: text }, { sourceOrdinal: integer }),
});
const state = object({
  amountMinor: integer, netMinor: integer, taxMinor: integer, totalMinor: integer,
  taxPositions: array(object({ positionRef: text, jurisdictionRef: text, taxableMinor: integer, taxMinor: integer }, { rateDecimal: text }), 32),
});
const allocation = object({
  adjustmentRef: text, sequence: integer, basisReductionMinor: integer, beforeMinor: integer, afterMinor: integer,
  before: state, after: state, netReductionMinor: integer, taxReductionMinor: integer,
});
const moneyResult = object({
  amountBasis: oneOf("exclusive", "inclusive"), fees: array(object({ feeKey: text, amountMinor: integer }), 256),
  components: array(object({ ref: componentRef, initial: state, allocations: array(allocation, 256), final: state }), 512),
  netTotal: integer, taxTotal: integer, feeTotal: integer, payableMinor: integer,
});
const success = object({ kind: oneOf("final", "estimate"), money: moneyResult, evidence: value => value, evidenceDigest: text });
const readResult = variant<ReturnType<typeof success> | undefined>("kind", {
  final: success, estimate: success, refused: () => undefined, unavailable: () => undefined,
});

type CheckedQuoteResult = {
  original: TaxQuoteRequestV1;
  result?: Omit<Extract<TaxQuoteResultV1, { kind: "final" | "estimate" }>, "evidence"> & { evidence: TaxCalculationEvidenceV1 };
};

function snapshotQuoteResult(result: TaxQuoteResultV1): TaxQuoteResultV1 {
  // The money decoder owns its count limits. Evidence has its own byte limit.
  let snapshot: TaxQuoteResultV1;
  let evidence: PropertyDescriptor | undefined;
  try {
    let envelope = result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const { evidence: descriptor, ...fields } = Object.getOwnPropertyDescriptors(result);
      evidence = descriptor;
      envelope = Object.create(Object.getPrototypeOf(result), fields) as TaxQuoteResultV1;
    }
    snapshot = JSON.parse(JSON.stringify(envelope)) as TaxQuoteResultV1;
  } catch { return referenceConflict(""); }

  if (!evidence) return snapshot;
  if (!("value" in evidence)) referenceConflict("/evidence");
  return { ...snapshot, evidence: snapshotDocument(evidence.value, "/evidence") } as TaxQuoteResultV1;
}

export function checkedQuoteResult(request: TaxQuoteRequestV1, result: TaxQuoteResultV1): CheckedQuoteResult | TaxRefusal {
  try {
    const originalSnapshot = snapshotDocument(request);
    const resultSnapshot = snapshotQuoteResult(result);
    verifyIntegrity(originalSnapshot, { result: resultSnapshot });
    const original = taxQuoteRequestV1Schema.parse(originalSnapshot);
    const parsed = readResult(resultSnapshot, "");
    if (!parsed) return { original, result: undefined };
    const evidence = quoteEvidenceSchema.safeParse(parsed.evidence);
    if (!evidence.success) return decodeRefusal(evidence.error, "/evidence");
    const wrongMoney = verifyMoney(original.input.money, parsed.money);
    if (wrongMoney) return wrongMoney;
    const assessments = collectAssessments(original.input, parsed.money);
    if ("kind" in assessments) return assessments;
    return verifyEvidenceMetadata(original, evidence.data, assessments) ?? { original, result: { ...parsed, evidence: evidence.data } };
  } catch (error) { return decodeRefusal(error); }
}

/** Verify quote and evidence integrity before validating and reconciling a successful result. */
export function verifyTaxQuoteResult(request: TaxQuoteRequestV1, result: TaxQuoteResultV1): TaxRefusal | undefined {
  const checked = checkedQuoteResult(request, result);
  if ("kind" in checked) return checked;
}
