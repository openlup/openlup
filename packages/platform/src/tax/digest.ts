import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error } from "@openlup/core/pricing";
import type { CatalogueMoneyV2Result, CatalogueMoneyV2State } from "@openlup/core/pricing";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import { bounded, exclusiveTaxRemedy, invalid } from "./contracts/decode.js";
import { cellKey, compareCells, compareDeclarations, declarationKey, includesInstant, sameCell } from "./contracts/identity.js";
import {
  parseQuoteKey, quoteInputSchema, taxCalculationEvidenceV1Schema, taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema,
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

function verifyInputDigest(request: TaxQuoteRequestV1, path = ""): TaxRefusal | undefined {
  if (!matchesDigest("input", normalize(request.input), request.inputDigest)) {
    return refuse("tax_reference_conflict", path + "/inputDigest", "Replay the original request or rebuild it with a new key.");
  }
}

function verifyEvidence(
  request: TaxQuoteRequestV1, evidence: TaxCalculationEvidenceV1, digest: string,
): TaxRefusal | undefined {
  if (!matchesDigest("evidence", evidence, digest)) {
    return refuse("tax_reference_conflict", "/evidenceDigest", "Supply the original evidence and its digest.");
  }

  const input = request.input;
  const pairs = {
    scope: [canonicalCatalogDraftJson(evidence.scope), canonicalCatalogDraftJson(input.scope)],
    status: [evidence.status, input.purpose], taxDate: [evidence.taxDate, input.taxDate],
    inputDigest: [evidence.inputDigest, request.inputDigest], destinationDigest: [evidence.destinationDigest, input.destination.digest],
    shipFromRef: [evidence.shipFromRef, input.shipFromRef], policyRevision: [evidence.policyRevision, input.policyRevision],
    classMapRevision: [evidence.classMapRevision, input.classMapRevision],
  };
  for (const [field, [actual, expected]] of Object.entries(pairs)) {
    if (actual !== expected) {
      return refuse("tax_reference_conflict", "/evidence/" + field, "Supply evidence from the original quote request.");
    }
  }

  const { vector } = evidence.coverage;
  if (!matchesDigest("coverage", vector, evidence.coverage.digest)) {
    return refuse("tax_reference_conflict", "/evidence/coverage/digest", "Supply the coverage vector with its original digest.");
  }
  const required = [...input.required].sort(compareCells);
  if (vector.length !== required.length || vector.some((row, index) => !sameCell(row.cell, required[index]))) {
    return refuse("tax_reference_conflict", "/evidence/coverage/vector", "Reconcile the original quote's required cells.");
  }
  const declarations = new Map(input.coverage.declarations.filter(entry => includesInstant(entry.effective, input.taxDate))
    .map(entry => [declarationKey(entry), canonicalCatalogDraftJson(entry)]));
  for (const [index, row] of vector.entries()) {
    const actual = row.declaration && canonicalCatalogDraftJson(row.declaration);
    if (actual !== declarations.get(declarationKey(row.cell))) {
      return refuse("tax_reference_conflict", "/evidence/coverage/vector/" + index + "/declaration",
        "Reconcile coverage with the original quote's effective merchant declaration.");
    }
  }

  const lines = new Map(input.lines.map(item => [item.lineKey, item.assignmentRef]));
  const buckets = new Map(input.delivery.map(item => [item.bucketKey, item.assignmentRef]));
  for (const [index, { cell: { target }, resolution, resolutionDigest }] of evidence.positions.tax.entries()) {
    const path = "/evidence/positions/tax/" + index;
    const assignment = (target.kind === "line" ? lines : buckets).get(target.key);
    if (assignment !== resolution.assignmentRef) {
      return refuse("tax_reference_conflict", path + "/resolution/assignmentRef", "Use the original component's tax assignment.");
    }
    if (!matchesDigest("resolution", resolution, resolutionDigest)) {
      return refuse("tax_reference_conflict", path + "/resolutionDigest", "Recompute the digest from this rule resolution.");
    }
  }

  const { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision, positions } = evidence;
  const tax = positions.tax.map(({ resolutionDigest: _digest, providerLineRef: _providerRef, ...row }) => row);
  const fiscal = { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision,
    coverage: vector, tax, fees: positions.fees };
  if (!matchesDigest("fiscal", fiscal, evidence.fiscalDigest)) {
    return refuse("tax_reference_conflict", "/evidence/fiscalDigest", "Recompute the digest from the documented fiscal payload.");
  }
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

function verifyMetadata(evidence: TaxCalculationEvidenceV1, money: CatalogueMoneyV2Result): TaxRefusal | undefined {
  const metadata = new Map(evidence.positions.tax.map((row, index) => [row.positionRef, { row, index }]));
  const coverage = new Map(evidence.coverage.vector.map(row => [cellKey(row.cell), row.decision]));
  const seen = new Set<string>();
  for (const [componentIndex, { ref, initial, allocations }] of money.components.entries()) {
    const kind = ref.kind === "merchandise" ? "line" : "delivery";
    const key = ref.kind === "merchandise" ? ref.lineKey : ref.bucketKey;
    // Recomputed equality also binds the mirrored before and final states.
    const states = [initial, ...allocations.map(row => row.after)];
    for (const [stateIndex, state] of states.entries()) {
      for (const [positionIndex, position] of state.taxPositions.entries()) {
        const positionPath = "/money/components/" + componentIndex + "/" + statePath(stateIndex) + "/taxPositions/" + positionIndex;
        const match = metadata.get(position.positionRef);
        if (!match) {
          return refuse("tax_breakdown_incomplete", positionPath + "/positionRef", "Supply one metadata row for this money tax position.");
        }
        const { row, index } = match;
        const path = "/evidence/positions/tax/" + index;
        if (row.cell.target.kind !== kind || row.cell.target.key !== key) {
          return refuse("tax_breakdown_incomplete", path + "/cell/target", "Bind this metadata to the money position's component.");
        }
        if (row.cell.jurisdiction !== position.jurisdictionRef) {
          return refuse("tax_breakdown_incomplete", path + "/cell/jurisdiction", "Use the money position's jurisdiction.");
        }
        if (row.ratePercent !== position.rateDecimal) {
          return refuse("tax_breakdown_incomplete", path + "/ratePercent", "Use the money position's rate, or omit it when the position has no rate.");
        }
        if (position.taxMinor > 0 && coverage.get(cellKey(row.cell)) !== "in_scope_taxed") {
          return refuse("tax_breakdown_incomplete", positionPath + "/taxMinor", "Supply zero tax for a cell outside taxable coverage.");
        }
        seen.add(position.positionRef);
      }
    }
  }
  const orphan = evidence.positions.tax.findIndex(row => !seen.has(row.positionRef));
  if (orphan !== -1) {
    return refuse("tax_breakdown_incomplete", "/evidence/positions/tax/" + orphan + "/positionRef", "Remove metadata without a matching money tax position.");
  }

  const fees = new Set(money.fees.map(row => row.feeKey));
  for (const [index, row] of evidence.positions.fees.entries()) {
    if (!fees.delete(row.feeKey)) {
      return refuse("tax_breakdown_incomplete", "/evidence/positions/fees/" + index + "/feeKey", "Remove metadata without a matching money fee.");
    }
  }
  const missing = money.fees.findIndex(row => fees.has(row.feeKey));
  if (missing !== -1) {
    return refuse("tax_breakdown_incomplete", "/money/fees/" + missing + "/feeKey", "Supply one metadata row for this calculated fee.");
  }
}

/** Recompute a successful quote's money and verify every evidence binding. Returns a refusal on failure. */
export function verifyTaxQuoteResult(request: TaxQuoteRequestV1, result: TaxQuoteResultV1): TaxRefusal | undefined {
  const checked = checkedQuoteRequest(request);
  if ("kind" in checked) return checked;
  if (result.kind === "refused" || result.kind === "unavailable") return;

  const decoded = taxCalculationEvidenceV1Schema.safeParse(result.evidence);
  if (!decoded.success) {
    const { field, message } = decoded.error;
    return refuse(field.startsWith("/positions") ? "tax_breakdown_incomplete" : "tax_calculation_unusable",
      "/evidence" + field, message);
  }
  const evidence = decoded.data;
  if (result.kind !== evidence.status) {
    return refuse("tax_calculation_unusable", "/evidence/status", "Supply evidence with the same status as the quote result.");
  }
  return verifyMoney(checked.input.money, result.money)
    ?? verifyEvidence(checked, evidence, result.evidenceDigest)
    ?? verifyMetadata(evidence, result.money);
}
