import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error } from "@openlup/core/pricing";
import type { CatalogueMoneyV2ComponentRef, CatalogueMoneyV2Result, CatalogueMoneyV2State } from "@openlup/core/pricing";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import { array, bounded, checked, exclusiveTaxRemedy, invalid, object, oneOf, variant } from "./contracts/decode.js";
import { cellKey, compareCells, compareDeclarations, decisionIsPossible, declarationKey, includesInstant, permitsAssessment, sameCell } from "./contracts/identity.js";
import {
  parseQuoteKey, quoteEvidenceSchema, quoteInputSchema, taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema,
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

function requestRepair(refusal: TaxRefusal, value: unknown): TaxRefusal {
  try {
    const expected = JSON.parse(canonicalCatalogDraftJson(value)) as TaxRefusal["expected"];
    return { ...refusal, expected, remedy: "Write `expected` at `field`, then refresh the digests." };
  } catch {
    return refusal;
  }
}

function verifyDigest(tag: DigestTag, document: unknown, digest: string, field: string, remedy: string): TaxRefusal | undefined {
  try {
    if (taxDigest(tag, document) === digest) return;
  } catch {
    // A payload outside the canonical limit cannot match the original digest.
  }
  return refuse("tax_reference_conflict", field, remedy);
}

function verifyInputDigest(request: TaxQuoteRequestV1, path = ""): TaxRefusal | undefined {
  return verifyDigest("input", normalize(request.input), request.inputDigest, path + "/inputDigest",
    "Replay the original request or rebuild it with a new key.");
}

function verifyEvidence(
  request: TaxQuoteRequestV1, evidence: TaxCalculationEvidenceV1, digest: string, assessments?: readonly Located[],
): TaxRefusal | undefined {
  const badDigest = verifyDigest("evidence", evidence, digest, "/evidenceDigest", "Replay the original evidence and its digest.");
  if (badDigest) return badDigest;

  const input = request.input;
  const pairs = {
    scope: [evidence.scope, input.scope],
    status: [evidence.status, input.purpose], taxDate: [evidence.taxDate, input.taxDate],
    inputDigest: [evidence.inputDigest, request.inputDigest], destinationDigest: [evidence.destinationDigest, input.destination.digest],
    shipFromRef: [evidence.shipFromRef, input.shipFromRef], policyRevision: [evidence.policyRevision, input.policyRevision],
    classMapRevision: [evidence.classMapRevision, input.classMapRevision],
  };
  for (const [field, [actual, expected]] of Object.entries(pairs)) {
    if (isDeepStrictEqual(actual, expected)) continue;
    return refuse("tax_reference_conflict", "/evidence/" + field, field === "status"
      ? "Obtain the calculation for the original quote's purpose."
      : "Obtain the calculation for the original request and account.");
  }

  const { vector } = evidence.coverage;
  const badCoverage = verifyDigest("coverage", vector, evidence.coverage.digest, "/evidence/coverage/digest",
    "Replay the original coverage vector and its digest.");
  if (badCoverage) return badCoverage;
  const required = [...input.required].sort(compareCells);
  if (vector.length !== required.length || vector.some((row, index) => !sameCell(row.cell, required[index]))) {
    return refuse("tax_reference_conflict", "/evidence/coverage/vector", "Reconcile the original quote's required cells.");
  }
  const declarations = new Map(input.coverage.declarations.filter(entry => includesInstant(entry.effective, input.taxDate))
    .map(entry => [declarationKey(entry), entry]));
  for (const [index, row] of vector.entries()) {
    if (!decisionIsPossible(row)) {
      return refuse("tax_calculation_unusable", "/evidence/coverage/vector/" + index + "/decision",
        "Reconcile the named cell from effective observations.");
    }
    const declaration = declarations.get(declarationKey(row.cell));
    if (!isDeepStrictEqual(row.declaration, declaration)) {
      return refuse("tax_reference_conflict", "/evidence/coverage/vector/" + index + "/declaration",
        "Reconcile coverage with the original quote's effective merchant declaration.");
    }
  }

  const coverage = new Map(vector.map(row => [cellKey(row.cell), row]));
  const lines = new Map(input.lines.map(item => [item.lineKey, item.assignmentRef]));
  const buckets = new Map(input.delivery.map(item => [item.bucketKey, item.assignmentRef]));
  const assignmentFor = ({ target }: Cell) => (target.kind === "line" ? lines : buckets).get(target.key);
  const mismatch = assessments && verifyAssessments(assessments, evidence, coverage, assignmentFor, input.policyRevision);
  if (mismatch) return mismatch;

  for (const [index, row] of evidence.positions.tax.entries()) {
    const path = "/evidence/positions/tax/" + index;
    const binding = verifyTaxMetadata(row, path, row.cell, required, assignmentFor(row.cell), input.policyRevision,
      coverage.get(cellKey(row.cell))?.treatment?.ruleRef ?? row.ruleRef, "tax_reference_conflict");
    if (binding) return binding;
    const badResolution = verifyDigest("resolution", row.resolution, row.resolutionDigest, path + "/resolutionDigest",
      "Replay the original rule resolution and its digest.");
    if (badResolution) return badResolution;
  }

  const { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision, positions } = evidence;
  const tax = positions.tax.map(({ resolutionDigest: _digest, providerLineRef: _providerRef, ...row }) => row);
  const fiscal = { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision,
    coverage: vector, tax, fees: positions.fees };
  return verifyDigest("fiscal", fiscal, evidence.fiscalDigest, "/evidence/fiscalDigest",
    "Replay the original fiscal evidence and its digests.");
}

function checkedQuoteRequest(request: TaxQuoteRequestV1): TaxQuoteRequestV1 | TaxRefusal {
  const parsed = taxQuoteRequestV1Schema.safeParse(request);
  if (!parsed.success) return refuse(parsed.error.code, parsed.error.field, parsed.error.message);
  return verifyInputDigest(parsed.data) ?? parsed.data;
}

/** Verify the quote digest or, for fiscal validity, its original quote and bound evidence. Returns a refusal on failure. */
export function verifyTaxQuoteRequest(request: TaxQuoteRequestV1 | TaxFiscalValidityRequestV1): TaxRefusal | undefined {
  if ("original" in request) {
    const parsed = taxFiscalValidityRequestV1Schema.safeParse(request);
    if (!parsed.success) return refuse(parsed.error.code, parsed.error.field, parsed.error.message);
    const { original, evidence, evidenceDigest } = parsed.data;
    return verifyInputDigest(original, "/original") ?? verifyEvidence(original, evidence, evidenceDigest);
  }
  const checked = checkedQuoteRequest(request);
  return "kind" in checked ? checked : undefined;
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

const ambiguousCell = "The required cell is ambiguous. Return the original breakdown that identifies the tax kind or fee scope.";

function cellRepair(path: string, actual: Record<string, unknown>, required: Record<string, unknown>, fee = false) {
  const fields = Object.keys(required).filter(key => !isDeepStrictEqual(actual[key], required[key]));
  if (fields.length === 1) {
    const [key] = fields;
    return requestRepair(refuse("tax_breakdown_incomplete", path + "/" + key, "Use the matching required cell field."), required[key]);
  }
  if (fee) return refuse("tax_breakdown_incomplete", path, "Obtain fee metadata with the required jurisdiction, fee kind and scope.");
  return requestRepair(refuse("tax_breakdown_incomplete", path, "Bind the metadata to the matching required cell."), required);
}

type TaxMetadata = TaxCalculationEvidenceV1["positions"]["tax"][number];

function verifyTaxMetadata(row: TaxMetadata, path: string, cell: Cell, required: readonly Cell[], assignmentRef: string | undefined,
  policyRevision: string, ruleRef: string, code: TaxRefusal["code"]): TaxRefusal | undefined {
  const bindings = ([
    ["/resolution/assignmentRef", row.resolution.assignmentRef, assignmentRef, "Use the original component's tax assignment."],
    ["/resolution/policyRevision", row.resolution.policyRevision, policyRevision, "Use the original quote's policy revision."],
    ["/ruleRef", row.ruleRef, ruleRef, "Obtain the calculation with the rule from the matched coverage treatment."],
  ] as const).filter(([, actual, expected]) => actual !== expected);
  const cellChanged = !sameCell(row.cell, cell);
  if (!cellChanged && !bindings.length) return;
  if (required.filter(candidate => cellCoordinates(candidate) === cellCoordinates(cell)).length !== 1) {
    return refuse(code, path, ambiguousCell);
  }
  if (cellChanged && !bindings.length) return cellRepair(path + "/cell", row.cell, cell);
  if (cellChanged || bindings.length > 1) {
    return refuse(code, path, "Obtain the original metadata for the required cell, component assignment and coverage treatment.");
  }
  const [field, , value, remedy] = bindings[0];
  const refusal = refuse(code, path + field, remedy);
  // The request's coverage document contains declarations, not treatment rules.
  return field === "/ruleRef" || value === undefined ? refusal : requestRepair(refusal, value);
}

function feeCellValues({ jurisdiction, feeKind, scope }: TaxCalculationEvidenceV1["positions"]["fees"][number]) {
  return { jurisdiction, feeKind, scope };
}

function feeCell(cell: Cell) {
  return {
    jurisdiction: cell.jurisdiction, feeKind: cell.taxKind,
    scope: cell.target.kind === "fee" && cell.target.deliveryKey !== undefined
      ? { kind: "delivery" as const, key: cell.target.deliveryKey } : { kind: "order" as const },
  };
}

function verifyAssessments(rows: readonly Located[], evidence: TaxCalculationEvidenceV1, coverage: ReadonlyMap<string, Row>,
  assignmentFor: (cell: Cell) => string | undefined, policyRevision: string): TaxRefusal | undefined {
  type Positions = TaxCalculationEvidenceV1["positions"];
  type Entry = { path: string } & ({ kind: "tax"; row: Positions["tax"][number] } | { kind: "fee"; row: Positions["fees"][number] });
  const metadata = new Map<string, Entry>([
    ...evidence.positions.tax.map((row, index) => ["tax:" + row.positionRef, { kind: "tax", row, path: "/evidence/positions/tax/" + index }] as const),
    ...evidence.positions.fees.map((row, index) => ["fee:" + row.feeKey, { kind: "fee", row, path: "/evidence/positions/fees/" + index }] as const),
  ]);
  const used = new Set<string>();
  const highest = new Map<string, number>();
  for (const { assessment: { kind, id, minor } } of rows) {
    const key = kind + ":" + id;
    highest.set(key, Math.max(highest.get(key) ?? 0, minor));
  }
  for (const { assessment, candidates } of rows) {
    const { kind, id, minor, path } = assessment;
    const tag = kind + ":" + id;
    const entry = metadata.get(tag);
    const decision = (candidate: Cell) => coverage.get(cellKey(candidate))!.decision;
    const admissible = candidates.filter(candidate => permitsAssessment(kind, decision(candidate), minor));
    const cell = entry?.kind === "tax" ? candidates.find(candidate => sameCell(candidate, entry.row.cell))
      : entry && candidates.find(candidate => isDeepStrictEqual(feeCell(candidate), feeCellValues(entry.row)));

    // A matched cell governs its amount. Coverage cannot disambiguate request cells for a repair.
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
    if (entry.kind === "tax" && assessment.kind === "tax" && entry.row.ratePercent !== assessment.rate) {
      return refuse("tax_breakdown_incomplete", entry.path + "/ratePercent",
        "Re-obtain the calculation. The money result and evidence disagree on the rate.");
    }
    if (!cell) {
      if (candidates.length !== 1) {
        return refuse("tax_breakdown_incomplete", entry.path + (entry.kind === "tax" ? "/cell" : ""), ambiguousCell);
      }
      const [required] = candidates;
      if (!permitsAssessment(kind, decision(required), highest.get(tag)!)) {
        return refuse("tax_breakdown_incomplete", assessmentRef(assessment),
          "Re-obtain the calculation with one covered assessment cell across all states.");
      }
      if (entry.kind === "fee") return cellRepair(entry.path, feeCellValues(entry.row), feeCell(required), true);
      return verifyTaxMetadata(entry.row, entry.path, required, candidates, assignmentFor(required), policyRevision,
        coverage.get(cellKey(required))?.treatment?.ruleRef ?? entry.row.ruleRef, "tax_breakdown_incomplete");
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

/** Recompute a successful quote's money and verify every evidence binding. Returns a refusal on failure. */
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
  if (!parsed) return;

  const wrongMoney = verifyMoney(checked.input.money, parsed.money);
  if (wrongMoney) return wrongMoney;
  const assessments = collectAssessments(checked.input, parsed.money);
  if ("kind" in assessments) return assessments;
  const decoded = quoteEvidenceSchema.safeParse(parsed.evidence);
  if (!decoded.success) return refuse(decoded.error.code, "/evidence" + decoded.error.field, decoded.error.message);
  if (parsed.kind !== decoded.data.status) {
    return decoded.data.status === checked.input.purpose
      ? refuse("tax_calculation_unusable", "/kind", "Obtain the result for the original quote's purpose.")
      : refuse("tax_calculation_unusable", "/evidence/status", "Obtain the calculation evidence for the original quote's purpose.");
  }
  return verifyEvidence(checked, decoded.data, parsed.evidenceDigest, assessments);
}
