import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error } from "@openlup/core/pricing";
import type { CatalogueMoneyV2ComponentRef, CatalogueMoneyV2Result, CatalogueMoneyV2State } from "@openlup/core/pricing";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import { array, bounded, checked, exclusiveTaxRemedy, invalid, object, oneOf, schema, variant } from "./contracts/decode.js";
import type { Decode } from "./contracts/decode.js";
import { cellKey, compareCells, compareDeclarations, permitsAssessment, sameCell } from "./contracts/identity.js";
import {
  cell, checkChargeDate, checkEvidence, checkQuoteInput, checkQuoteMoney, declaration, digest, evidenceFields, fiscalValidityFields, instant,
  parseQuoteKey, quoteInputSchema, quotePurpose, quoteRequestFields, reconcileEvidence, ref, scopeMode, targetKind,
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
  tax_reference_conflict: "Replay the intended original request under its original key with its original digest and, where applicable, its matching calculation evidence and original digests. For fiscal validity, obtain fresh charge-time input from the original scope without copying or relabelling scope members.",
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

function decodeRefusal(error: unknown): TaxRefusal {
  if (error instanceof Error && "field" in error && typeof error.field === "string"
    && "code" in error && typeof error.code === "string" && Object.hasOwn(remedies, error.code)) {
    return refuseVerification(error.code as VerifierCode, error.field);
  }
  return refuseVerification("tax_invalid_input", "");
}

const absent = Symbol("absent");
const blocked = Symbol("blocked");
const limit = 1_048_576;

function record(value: unknown): value is object {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function data(record: unknown, key: PropertyKey): unknown {
  if (typeof record !== "object" || record === null || types.isProxy(record)) return blocked;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return absent;
  return descriptor.enumerable && "value" in descriptor ? descriptor.value : blocked;
}

function rows(value: unknown): unknown[] | undefined {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit) return;
  return Array.from({ length: value.length }, (_, index) => data(value, index));
}

// Keep every raw field, including unknown ones. The canonicalizer still owns the JSON dialect and byte limit.
function snapshot(value: unknown): unknown {
  let remaining = limit;
  function visit(raw: unknown, depth: number): unknown {
    remaining -= typeof raw === "string" ? Math.max(1, raw.length) : 1;
    if (remaining < 0 || depth > 48 || typeof raw === "symbol" || types.isProxy(raw)) throw new TypeError("Unusable tax document");
    if (raw === null || typeof raw !== "object") return raw;
    const keys = Reflect.ownKeys(raw);
    if (Array.isArray(raw)) {
      const items = rows(raw);
      if (!items || keys.length !== items.length + 1) throw new TypeError("Unusable tax array");
      return items.map(item => visit(item, depth + 1));
    }
    if (!record(raw) || keys.length > remaining) throw new TypeError("Unusable tax record");
    return Object.fromEntries(keys.map(key => {
      if (typeof key !== "string") throw new TypeError("Unusable tax field");
      remaining -= key.length;
      return [key, visit(data(raw, key), depth + 1)];
    }));
  }
  return visit(value, 0);
}

type FiscalEvidence = Pick<TaxCalculationEvidenceV1,
  "scope" | "destinationDigest" | "shipFromRef" | "policyRevision" | "classMapRevision" | "coverage" | "positions">;

const fiscalKeys = ["scope", "destinationDigest", "shipFromRef", "policyRevision", "classMapRevision"] as const;
function fiscalPayload(evidence: unknown) {
  const positions = data(evidence, "positions");
  const tax = rows(data(positions, "tax"))?.map(row => record(row)
    ? Object.fromEntries(Reflect.ownKeys(row).filter(key => key !== "resolutionDigest" && key !== "providerLineRef")
      .map(key => [key, data(row, key)]))
    : blocked);
  return { ...Object.fromEntries(fiscalKeys.map(key => [key, data(evidence, key)])),
    coverage: data(data(evidence, "coverage"), "vector"), tax, fees: data(positions, "fees") };
}

export const taxFiscalDigest = (evidence: FiscalEvidence): string => taxDigest("fiscal", fiscalPayload(evidence));

function readable<T>(decode: Decode<T>, value: unknown): T | undefined {
  try { return decode(value, ""); }
  catch { return undefined; }
}

function readableDocument<T>(decode: Decode<T>, value: unknown): T | undefined {
  try { return decode(snapshot(value), ""); }
  catch { return undefined; }
}

function coordinates(row: unknown) {
  return { jurisdiction: readable(ref, data(row, "jurisdiction")), taxKind: readable(ref, data(row, "taxKind")) };
}

function cellsWithSortKeys(required: unknown[] | undefined) {
  if (!required) return;
  const entries = [];
  for (const row of required) {
    const target = data(row, "target");
    const { jurisdiction, taxKind } = coordinates(row);
    const kind = readable(targetKind, data(target, "kind")), key = readable(ref, data(target, "key"));
    if (!jurisdiction || !taxKind || !kind || !key) return;
    entries.push({ identity: { target: { kind, key }, jurisdiction, taxKind }, row });
  }
  return entries;
}

function sortableDeclarations(entries: unknown[] | undefined): boolean {
  return !!entries?.every(row => {
    const { jurisdiction, taxKind } = coordinates(row);
    return jurisdiction && taxKind && readable(instant, data(data(row, "effective"), "from"));
  });
}

type Anchor = { field: string; value: string | undefined };
type Binding = { actual: Anchor; original?: Anchor; field?: string };
function bindingField(bindings: readonly Binding[]): string | undefined {
  let malformed: string | undefined;
  for (const { actual, original, field } of bindings) {
    if (actual.value === undefined) malformed ??= actual.field;
    if (original && original.value === undefined) malformed ??= original.field;
    if (actual.value !== undefined && original?.value !== undefined && actual.value !== original.value) return field ?? actual.field;
  }
  return malformed;
}

function anchor(parent: unknown, key: string, path: string, decode: Decode<string> = ref): Anchor {
  return { field: path + "/" + key, value: readable(decode, data(parent, key)) };
}

const scopeKeys = ["adapter", "adapterVersion", "accountRef", "mode"] as const;
function scopeBindings(actual: unknown, original: unknown, path: string, origin: string): Binding[] {
  if (!record(actual) || !record(original)) return [{ actual: { field: record(actual) ? origin : path, value: undefined } }];
  return scopeKeys.map(key => ({
    actual: anchor(actual, key, path, key === "mode" ? scopeMode : ref),
    original: anchor(original, key, origin, key === "mode" ? scopeMode : ref), field: path,
  }));
}

function accountBinding(input: unknown, path: string): Binding {
  return { actual: anchor(data(input, "coverage"), "accountRef", path + "/coverage"),
    original: anchor(data(input, "scope"), "accountRef", path + "/scope") };
}

function canonical(value: unknown, decode?: Decode<unknown>): string | undefined {
  try {
    const document = snapshot(value);
    decode?.(document, "");
    return canonicalCatalogDraftJson(document);
  } catch { return undefined; }
}

function declarationConflict(
  vector: unknown[], declarations: unknown[] | undefined, date: string | undefined, defer: (field: string) => void,
): string | undefined {
  if (!declarations || !date) return;
  const key = (jurisdiction?: string, kind?: string) => JSON.stringify([jurisdiction, kind]);
  const effective = new Map<string, string | undefined>();
  for (const row of declarations) {
    const interval = data(row, "effective");
    const from = readable(instant, data(interval, "from"));
    const end = data(interval, "until");
    const until = readable(instant, end);
    if ((from && from > date) || (until && until <= date)) continue;
    const { jurisdiction, taxKind } = coordinates(row);
    const id = key(jurisdiction, taxKind);
    effective.set(id, !effective.has(id) && from && (end === absent || until) ? canonical(row, declaration) : undefined);
  }
  for (const [index, row] of vector.entries()) {
    const { jurisdiction, taxKind } = coordinates(data(row, "cell"));
    if (!jurisdiction || !taxKind || effective.has(key(jurisdiction)) || effective.has(key(undefined, taxKind)) || effective.has(key())) continue;
    const id = key(jurisdiction, taxKind);
    const original = effective.get(id);
    if (original === undefined && effective.has(id)) continue;
    const raw = data(row, "declaration");
    const path = "/evidence/coverage/vector/" + index + "/declaration";
    const actual = raw === absent ? undefined : canonical(raw);
    if (raw !== absent && actual === undefined) defer(path);
    else if (original !== actual) return path;
  }
}

function verifyIntegrity(document: unknown, mode: "quote" | "fiscal" | "result", result?: unknown): string | undefined {
  const fiscal = mode === "fiscal";
  let deferred: string | undefined;
  const defer = (field: string) => { deferred ??= field; };
  const conflict = (field: string): never => invalid(field, remedies.tax_reference_conflict, "tax_reference_conflict");
  const original = fiscal ? data(document, "original") : document;
  const current = fiscal ? data(document, "current") : undefined;
  const base = fiscal ? "/original" : "";
  const inputPath = base + "/input";
  const input = data(original, "input");
  const required = rows(data(input, "required"));
  const keyedCells = cellsWithSortKeys(required);
  const declarations = rows(data(data(input, "coverage"), "declarations"));
  const inputDigest = anchor(original, "inputDigest", base, digest);
  const checkHash = (tag: DigestTag, payload: () => unknown, anchor: Anchor, path: string) => {
    if (anchor.value === undefined) conflict(anchor.field);
    let actual: string;
    try { actual = taxDigest(tag, payload()); }
    catch { return defer(path); }
    if (actual !== anchor.value) conflict(anchor.field);
  };
  if (record(original)) checkHash("input", () => {
    if (!keyedCells || !sortableDeclarations(declarations)) throw new TypeError("Unusable tax sort keys");
    return normalize(snapshot(input) as TaxQuoteInputV1);
  }, inputDigest, inputPath);

  const envelope = fiscal ? document : result;
  const kind = mode === "result" ? data(envelope, "kind") : absent;
  const success = readable(quotePurpose, kind);
  const knownNonSuccess = kind === "refused" || kind === "unavailable";
  const evidence = knownNonSuccess ? absent : data(envelope, "evidence");
  const evidenceApplies = fiscal || (mode === "result" && (success !== undefined || evidence !== absent));
  const coverage = data(evidence, "coverage");
  const vector = rows(data(coverage, "vector"));
  const tax = rows(data(data(evidence, "positions"), "tax"));
  if (evidenceApplies && record(envelope)) {
    if (record(evidence)) {
      for (const [index, row] of (tax ?? []).entries()) {
        if (!record(row)) continue;
        const path = "/evidence/positions/tax/" + index;
        const resolution = data(row, "resolution");
        checkHash("resolution", () => snapshot(resolution), anchor(row, "resolutionDigest", path, digest), path + "/resolution");
      }
      if (record(coverage)) checkHash("coverage", () => snapshot(data(coverage, "vector")),
        anchor(coverage, "digest", "/evidence/coverage", digest), "/evidence/coverage/vector");
      checkHash("fiscal", () => snapshot(fiscalPayload(evidence)), anchor(evidence, "fiscalDigest", "/evidence", digest), "/evidence");
    }
    checkHash("evidence", () => snapshot(evidence), anchor(envelope, "evidenceDigest", "", digest), "/evidence");
    for (const [index, row] of (tax ?? []).entries()) {
      const resolution = data(row, "resolution");
      const source = data(resolution, "sourceDigest");
      if (record(resolution) && source !== absent && readable(digest, source) === undefined) {
        conflict("/evidence/positions/tax/" + index + "/resolution/sourceDigest");
      }
    }
  }

  const key = anchor(original, "key", base);
  const destinationDigest = anchor(data(input, "destination"), "digest", inputPath + "/destination", digest);
  const purpose = anchor(input, "purpose", inputPath, quotePurpose);
  const echoes: Binding[] = [];
  if (evidenceApplies && record(evidence)) {
    const bound = (key: string, original?: Anchor, decode?: Decode<string>): Binding =>
      ({ actual: anchor(evidence, key, "/evidence", decode), original });
    echoes.push(bound("inputDigest", record(original) ? inputDigest : undefined, digest),
      bound("requestKey", record(original) ? key : undefined),
      bound("destinationDigest", record(input) ? destinationDigest : undefined, digest));
    if (record(input)) echoes.push(...scopeBindings(data(evidence, "scope"), data(input, "scope"), "/evidence/scope", inputPath + "/scope"));
    echoes.push(bound("status", record(input) ? purpose : undefined, quotePurpose));
    if (success && record(input)) echoes.push({ actual: { field: "/kind", value: success }, original: purpose });
    for (const field of ["taxDate", "shipFromRef", "policyRevision", "classMapRevision"]) {
      const decode = field === "taxDate" ? instant : ref;
      echoes.push(bound(field, record(input) ? anchor(input, field, inputPath, decode) : undefined, decode));
    }
  } else {
    if (record(original)) echoes.push({ actual: key });
    if (record(input)) echoes.push({ actual: destinationDigest });
  }
  if (record(current)) echoes.push({ actual: anchor(data(current, "destination"), "digest", "/current/destination", digest) });
  const echoConflict = bindingField(echoes);
  if (echoConflict !== undefined) conflict(echoConflict);

  const scopes: Binding[] = [];
  if (record(input)) scopes.push(accountBinding(input, inputPath));
  if (record(current)) scopes.push(accountBinding(current, "/current"));
  if (record(input) && record(current)) {
    scopes.push(...scopeBindings(data(current, "scope"), data(input, "scope"), "/current/scope", inputPath + "/scope"));
  }
  const scopeConflict = bindingField(scopes);
  if (scopeConflict !== undefined) conflict(scopeConflict);

  if (evidenceApplies && vector) {
    if (required && required.length !== vector.length) conflict("/evidence/coverage/vector");
    if (keyedCells) {
      keyedCells.sort((a, b) => compareCells(a.identity, b.identity));
      for (const [index, row] of vector.entries()) {
        const actual = readableDocument(cell, data(row, "cell"));
        const expected = readableDocument(cell, keyedCells[index]?.row);
        if (actual && expected && !sameCell(actual, expected)) conflict("/evidence/coverage/vector");
      }
    }
    const declarationField = declarationConflict(vector, declarations, readable(instant, data(input, "taxDate")), defer);
    if (declarationField) conflict(declarationField);
  }
  if (mode === "result" && record(envelope) && !success && !knownNonSuccess) conflict("/kind");
  return deferred;
}

function verifyEvidenceMetadata(
  request: TaxQuoteRequestV1, evidence: TaxCalculationEvidenceV1, assessments?: readonly Located[],
): TaxRefusal | undefined {
  const input = request.input;
  const { vector } = evidence.coverage;
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

const quoteStructure = schema(quoteRequestFields);
const fiscalStructure = schema(fiscalValidityFields);

export function checkedQuoteRequest(request: TaxQuoteRequestV1): TaxQuoteRequestV1 | TaxRefusal {
  try {
    const deferred = verifyIntegrity(request, "quote");
    const parsed = quoteStructure.parse(request);
    const { input } = parsed;
    checkQuoteInput(input, "/input");
    checkQuoteMoney(input.money, "/input/money");
    return deferred ? refuseVerification("tax_invalid_input", deferred) : { ...parsed, input };
  } catch (error) { return decodeRefusal(error); }
}

export function checkedFiscalValidity(request: TaxFiscalValidityRequestV1): TaxFiscalValidityRequestV1 | TaxRefusal {
  try {
    const deferred = verifyIntegrity(request, "fiscal");
    const parsed = fiscalStructure.parse(request);
    const { original, current, evidence } = parsed;
    const { input } = original;
    checkQuoteInput(input, "/original/input");
    checkQuoteInput(current, "/current");
    checkEvidence(evidence, "/evidence");
    const checked = { ...parsed, original: { ...original, input }, current };
    checkChargeDate(checked);
    checkQuoteMoney(input.money, "/original/input/money");
    checkQuoteMoney(current.money, "/current/money");
    if (deferred) return refuseVerification("tax_invalid_input", deferred);
    reconcileEvidence(evidence, "/evidence", "fiscal");
    return verifyEvidenceMetadata(checked.original, evidence) ?? checked;
  } catch (error) { return decodeRefusal(error); }
}

/** Verify quote or fiscal-validity integrity before input validation and reconciliation. */
export function verifyTaxQuoteRequest(request: TaxQuoteRequestV1 | TaxFiscalValidityRequestV1): TaxRefusal | undefined {
  const fiscal = record(request) && (data(request, "original") !== absent || (data(request, "input") === absent
    && ["current", "chargeAt", "evidence", "evidenceDigest"].some(key => data(request, key) !== absent)));
  const checked = fiscal ? checkedFiscalValidity(request as TaxFiscalValidityRequestV1) : checkedQuoteRequest(request as TaxQuoteRequestV1);
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
const success = object({ kind: quotePurpose, money: moneyResult, evidence: evidenceFields, evidenceDigest: digest });
const readResult = variant<ReturnType<typeof success> | undefined>("kind", {
  final: success, estimate: success, refused: () => undefined, unavailable: () => undefined,
});

/** Verify quote and evidence integrity before validating and reconciling a successful result. */
export function verifyTaxQuoteResult(request: TaxQuoteRequestV1, result: TaxQuoteResultV1): TaxRefusal | undefined {
  try {
    const deferred = verifyIntegrity(request, "result", result);
    const original = quoteStructure.parse(request);
    const parsed = readResult(result, "");
    const { input } = original;
    checkQuoteInput(input, "/input");
    if (parsed) checkEvidence(parsed.evidence, "/evidence");
    checkQuoteMoney(input.money, "/input/money");
    if (deferred) return refuseVerification("tax_invalid_input", deferred);
    if (!parsed) return;
    const wrongMoney = verifyMoney(input.money, parsed.money);
    if (wrongMoney) return wrongMoney;
    reconcileEvidence(parsed.evidence, "/evidence", "money");
    const assessments = collectAssessments(input, parsed.money);
    return "kind" in assessments ? assessments : verifyEvidenceMetadata({ ...original, input }, parsed.evidence, assessments);
  } catch (error) { return decodeRefusal(error); }
}
