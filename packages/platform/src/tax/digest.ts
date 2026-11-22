import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error } from "@openlup/core/pricing";
import type { CatalogueMoneyV2ComponentRef, CatalogueMoneyV2Result, CatalogueMoneyV2State } from "@openlup/core/pricing";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import { array, bounded, checked, exclusiveTaxRemedy, invalid, object, oneOf, variant } from "./contracts/decode.js";
import { cellKey, compareCells, compareDeclarations, decisionIsPossible, declarationKey, includesInstant, permitsAssessment, sameCell } from "./contracts/identity.js";
import {
  evidenceDocumentSchema, fiscalValidityDocumentSchema, parseQuoteKey, quoteEvidenceSchema, quoteInputSchema,
  quoteRequestDocumentSchema, taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema,
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

function refuse(code: TaxRefusal["code"], field: string, remedy: string): TaxRefusal {
  return { kind: "refused", code, field, remedy };
}

function matchesDigest(tag: DigestTag, document: unknown, digest: string): boolean {
  try { return taxDigest(tag, document) === digest; }
  catch { return false; }
}

function replayDigest(field: string, document: string): TaxRefusal {
  return refuse("tax_reference_conflict", field,
    "Replay the original " + document + " and its digest; a digest is never recomputed over a changed document.");
}

function verifyInputDigest(request: TaxQuoteRequestV1, path = ""): TaxRefusal | undefined {
  if (!matchesDigest("input", normalize(request.input), request.inputDigest)) {
    return replayDigest(path + "/inputDigest", "request input");
  }
}

function verifyEvidenceDigests(request: TaxQuoteRequestV1, evidence: TaxCalculationEvidenceV1, digest: string): TaxRefusal | undefined {
  const { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision, coverage, positions } = evidence;
  for (const [index, row] of positions.tax.entries()) {
    if (!matchesDigest("resolution", row.resolution, row.resolutionDigest)) {
      return replayDigest("/evidence/positions/tax/" + index + "/resolutionDigest", "rule resolution");
    }
  }
  if (!matchesDigest("coverage", coverage.vector, coverage.digest)) {
    return replayDigest("/evidence/coverage/digest", "coverage vector");
  }
  const tax = positions.tax.map(({ resolutionDigest: _digest, providerLineRef: _providerRef, ...row }) => row);
  const fiscal = { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision,
    coverage: coverage.vector, tax, fees: positions.fees };
  if (!matchesDigest("fiscal", fiscal, evidence.fiscalDigest)) {
    return replayDigest("/evidence/fiscalDigest", "fiscal payload");
  }
  if (!matchesDigest("evidence", evidence, digest)) {
    return replayDigest("/evidenceDigest", "calculation evidence");
  }
  if (evidence.inputDigest !== request.inputDigest) {
    return replayDigest("/evidence/inputDigest", "request input");
  }
  if (destinationDigest !== request.input.destination.digest) {
    return replayDigest("/evidence/destinationDigest", "calculation evidence");
  }
}

function verifyEvidenceBindings(
  request: TaxQuoteRequestV1, evidence: TaxCalculationEvidenceV1, assessments?: readonly Located[],
): TaxRefusal | undefined {
  const input = request.input;
  const pairs = {
    scope: [canonicalCatalogDraftJson(evidence.scope), canonicalCatalogDraftJson(input.scope)],
    status: [evidence.status, input.purpose], taxDate: [evidence.taxDate, input.taxDate],
    shipFromRef: [evidence.shipFromRef, input.shipFromRef], policyRevision: [evidence.policyRevision, input.policyRevision],
    classMapRevision: [evidence.classMapRevision, input.classMapRevision],
  };
  for (const [field, [actual, expected]] of Object.entries(pairs)) {
    if (actual !== expected) {
      return refuse("tax_reference_conflict", "/evidence/" + field, field === "status"
        ? "Use the original quote's purpose for the evidence status and any result kind."
        : "Supply evidence from the original quote request.");
    }
  }

  const { vector } = evidence.coverage;
  const required = [...input.required].sort(compareCells);
  if (vector.length !== required.length || vector.some((row, index) => !sameCell(row.cell, required[index]))) {
    return refuse("tax_reference_conflict", "/evidence/coverage/vector", "Reconcile the original quote's required cells.");
  }
  const declarations = new Map(input.coverage.declarations.filter(entry => includesInstant(entry.effective, input.taxDate))
    .map(entry => [declarationKey(entry), canonicalCatalogDraftJson(entry)]));
  for (const [index, row] of vector.entries()) {
    if (!decisionIsPossible(row)) {
      return refuse("tax_calculation_unusable", "/evidence/coverage/vector/" + index + "/decision",
        "Reconcile the named cell from effective observations.");
    }
    const actual = row.declaration && canonicalCatalogDraftJson(row.declaration);
    if (actual !== declarations.get(declarationKey(row.cell))) {
      return refuse("tax_reference_conflict", "/evidence/coverage/vector/" + index + "/declaration",
        "Reconcile coverage with the original quote's effective merchant declaration.");
    }
  }

  const coverage = new Map(vector.map(row => [cellKey(row.cell), row]));
  const mismatch = assessments && verifyAssessments(assessments, evidence, coverage);
  if (mismatch) return mismatch;

  const lines = new Map(input.lines.map(item => [item.lineKey, item.assignmentRef]));
  const buckets = new Map(input.delivery.map(item => [item.bucketKey, item.assignmentRef]));
  for (const [index, row] of evidence.positions.tax.entries()) {
    const { cell: { target }, resolution, ruleRef } = row;
    const path = "/evidence/positions/tax/" + index;
    const assignment = (target.kind === "line" ? lines : buckets).get(target.key);
    if (assignment !== resolution.assignmentRef) {
      return refuse("tax_reference_conflict", path + "/resolution/assignmentRef", "Use the original component's tax assignment.");
    }
    if (resolution.policyRevision !== evidence.policyRevision) {
      return refuse("tax_reference_conflict", path + "/resolution/policyRevision", "Use the original quote's policy revision.");
    }
    const treatment = coverage.get(cellKey(row.cell))?.treatment;
    if (treatment && ruleRef !== treatment.ruleRef) {
      return refuse("tax_reference_conflict", path + "/ruleRef", "Use the matched coverage treatment's rule reference.");
    }
  }
}

function checkedQuoteRequest(request: TaxQuoteRequestV1): TaxQuoteRequestV1 | TaxRefusal {
  const parsed = quoteRequestDocumentSchema.safeParse(request);
  if (!parsed.success) return refuse(parsed.error.code, parsed.error.field, parsed.error.message);
  return verifyInputDigest(parsed.data) ?? parsed.data;
}

function verifyQuoteBindings(request: TaxQuoteRequestV1): TaxRefusal | undefined {
  const parsed = taxQuoteRequestV1Schema.safeParse(request);
  if (!parsed.success) return refuse(parsed.error.code, parsed.error.field, parsed.error.message);
}

/** Verify the quote or fiscal-validity digests before returning binding repair advice. */
export function verifyTaxQuoteRequest(request: TaxQuoteRequestV1 | TaxFiscalValidityRequestV1): TaxRefusal | undefined {
  if ("original" in request) {
    const document = fiscalValidityDocumentSchema.safeParse(request);
    if (!document.success) return refuse(document.error.code, document.error.field, document.error.message);
    const { original, evidence, evidenceDigest } = document.data;
    const mismatch = verifyInputDigest(original, "/original") ?? verifyEvidenceDigests(original, evidence, evidenceDigest);
    if (mismatch) return mismatch;
    const parsed = taxFiscalValidityRequestV1Schema.safeParse(document.data);
    if (!parsed.success) return refuse(parsed.error.code, parsed.error.field, parsed.error.message);
    return verifyEvidenceBindings(original, evidence);
  }
  const checked = checkedQuoteRequest(request);
  return "kind" in checked ? checked : verifyQuoteBindings(checked);
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
  if (money.amountBasis === "inclusive") return refuse("tax_scope_mismatch", "/money/amountBasis", exclusiveTaxRemedy);
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
    if (field) return refuse("tax_breakdown_incomplete", field, "Return the money-v2 result for the original request and its tax evidence.");
  } catch (error) {
    if (!(error instanceof CatalogueMoneyV2Error)) throw error;
    return refuse("tax_breakdown_incomplete", moneyField(error.field), error.remedy);
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
          return refuse("tax_breakdown_incomplete", path + "/positionRef",
            "Re-obtain consistent position identities across states. Supply distinct refs for distinct positions.");
        }
        const candidates = required.get(coordinates);
        if (!candidates) return refuse("tax_breakdown_incomplete", path + "/jurisdictionRef",
          "Re-obtain the position or fee for a required cell of the original request.");
        identities.set(id, fingerprint);
        rows.push({ assessment: { kind: "tax", id, minor, path, rate }, candidates });
      }
    }
  }
  for (const [index, { feeKey: id, amountMinor: minor }] of money.fees.entries()) {
    const path = "/money/fees/" + index;
    const candidates = required.get(JSON.stringify(["fee", id]));
    if (!candidates) return refuse("tax_breakdown_incomplete", path + "/feeKey",
      "Re-obtain the position or fee for a required cell of the original request.");
    rows.push({ assessment: { kind: "fee", id, minor, path }, candidates });
  }
  return rows;
}

function cellRepair(actual: Record<string, unknown>, candidates: readonly Record<string, unknown>[], path: string) {
  for (const candidate of candidates) {
    const fields = Object.keys(candidate).filter(key => !isDeepStrictEqual(actual[key], candidate[key]));
    if (fields.length === 1) {
      const [field] = fields;
      return { field: path + "/" + field, remedy: "Use " + JSON.stringify(candidate[field]) + " from the matching required cell." };
    }
  }
  return { field: path, remedy: "Copy the complete matching required cell from the request." };
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

function verifyAssessments(rows: readonly Located[], evidence: TaxCalculationEvidenceV1, coverage: ReadonlyMap<string, Row>): TaxRefusal | undefined {
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

    // A matched cell governs its amount. Otherwise, choose a repair from admissible candidates without picking a cell.
    if (cell ? !permitsAssessment(kind, decision(cell), minor) : !admissible.length) {
      const decisions = (cell ? [cell] : candidates).map(decision);
      if (minor > 0 && decisions.some(decision => permitsAssessment(kind, decision, 0))) {
        return refuse("tax_breakdown_incomplete", path + (kind === "tax" ? "/taxMinor" : "/amountMinor"),
          "Re-obtain the calculation with zero assessment for the covered exemption or exclusion and reconcile payable.");
      }
      return refuse("tax_breakdown_incomplete", assessmentRef(assessment),
        decisions.every(decision => decision === "out_of_scope")
          ? "Omit the out-of-scope fee and its metadata, then reconcile payable." : "Obtain the missing proof before emitting an assessment.");
    }
    if (!entry) return refuse("tax_breakdown_incomplete", assessmentRef(assessment), "Supply one matching metadata row in the evidence.");
    if (!cell) {
      const { field, remedy } = entry.kind === "tax"
        ? cellRepair(entry.row.cell, admissible, entry.path + "/cell")
        : cellRepair(feeCellValues(entry.row), admissible.map(feeCell), entry.path);
      return refuse("tax_breakdown_incomplete", field, remedy);
    }
    if (entry.kind === "tax" && assessment.kind === "tax" && entry.row.ratePercent !== assessment.rate) {
      return refuse("tax_breakdown_incomplete", entry.path + "/ratePercent", "Copy the money position's rate or omit it when absent.");
    }
    used.add(tag);
  }

  for (const [key, { kind, path }] of metadata) {
    if (!used.has(key)) return refuse("tax_breakdown_incomplete", path + (kind === "tax" ? "/positionRef" : "/feeKey"),
      "Remove this metadata row.");
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

/** Verify a successful quote's digests before checking its money and evidence bindings. */
export function verifyTaxQuoteResult(request: TaxQuoteRequestV1, result: TaxQuoteResultV1): TaxRefusal | undefined {
  const checked = checkedQuoteRequest(request);
  if ("kind" in checked) return checked;
  let parsed: ReturnType<typeof readResult>;
  try { parsed = readResult(result, ""); }
  catch (error) {
    return error instanceof Error && "field" in error && typeof error.field === "string"
      ? refuse("tax_invalid_input", error.field, error.message)
      : refuse("tax_invalid_input", "", "Supply an ordinary quote result document.");
  }
  if (!parsed) return verifyQuoteBindings(checked);

  const document = evidenceDocumentSchema.safeParse(parsed.evidence);
  if (!document.success) return refuse(document.error.code, "/evidence" + document.error.field, document.error.message);
  const mismatch = verifyEvidenceDigests(checked, document.data, parsed.evidenceDigest);
  if (mismatch) return mismatch;

  const binding = verifyQuoteBindings(checked);
  if (binding) return binding;
  const wrongMoney = verifyMoney(checked.input.money, parsed.money);
  if (wrongMoney) return wrongMoney;
  const assessments = collectAssessments(checked.input, parsed.money);
  if ("kind" in assessments) return assessments;
  const decoded = quoteEvidenceSchema.safeParse(document.data);
  if (!decoded.success) return refuse(decoded.error.code, "/evidence" + decoded.error.field, decoded.error.message);
  if (parsed.kind !== decoded.data.status) {
    return decoded.data.status === checked.input.purpose
      ? refuse("tax_calculation_unusable", "/kind", "Use the original quote's purpose as the result kind.")
      : refuse("tax_calculation_unusable", "/evidence/status", "Return evidence with the correct result status.");
  }
  return verifyEvidenceBindings(checked, decoded.data, assessments);
}
