import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import { bounded, invalid } from "./contracts/decode.js";
import { compareCells, compareDeclarations, declarationKey, includesInstant, sameCell } from "./contracts/identity.js";
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
  for (const [index, { cell: { target }, resolution }] of evidence.positions.tax.entries()) {
    const assignment = (target.kind === "line" ? lines : buckets).get(target.key);
    if (assignment !== resolution.assignmentRef) {
      return refuse("tax_reference_conflict", "/evidence/positions/tax/" + index + "/resolution/assignmentRef",
        "Use the original component's tax assignment.");
    }
  }
}

/** Verify the quote digest or, for fiscal validity, its original quote and bound evidence. Returns a refusal on failure. */
export function verifyTaxQuoteRequest(request: TaxQuoteRequestV1 | TaxFiscalValidityRequestV1): TaxRefusal | undefined {
  if ("original" in request) {
    const parsed = taxFiscalValidityRequestV1Schema.safeParse(request);
    if (!parsed.success) return refuse(parsed.error.code, parsed.error.field, parsed.error.message);
    const { original, evidence, evidenceDigest } = parsed.data;
    return verifyInputDigest(original, "/original") ?? verifyEvidence(original, evidence, evidenceDigest);
  }
  const parsed = taxQuoteRequestV1Schema.safeParse(request);
  if (!parsed.success) return refuse(parsed.error.code, parsed.error.field, parsed.error.message);
  return verifyInputDigest(parsed.data);
}

/** Verify a successful quote's evidence and money-position references. Returns a refusal on failure. */
export function verifyTaxQuoteResult(request: TaxQuoteRequestV1, result: TaxQuoteResultV1): TaxRefusal | undefined {
  if (result.kind === "refused" || result.kind === "unavailable") return;
  const parsed = taxQuoteRequestV1Schema.safeParse(request);
  if (!parsed.success) return refuse(parsed.error.code, parsed.error.field, parsed.error.message);
  const invalidRequest = verifyInputDigest(parsed.data);
  if (invalidRequest) return invalidRequest;

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
  const failedBinding = verifyEvidence(parsed.data, evidence, result.evidenceDigest);
  if (failedBinding) return failedBinding;

  const metadata = new Map(evidence.positions.tax.map(row => [row.positionRef, row]));
  const seen = new Set<string>();
  for (const { ref, initial, allocations, final } of result.money.components) {
    const kind = ref.kind === "merchandise" ? "line" : "delivery";
    const key = ref.kind === "merchandise" ? ref.lineKey : ref.bucketKey;
    for (const state of [initial, ...allocations.flatMap(row => [row.before, row.after]), final]) {
      for (const { positionRef, taxMinor } of state.taxPositions) {
        const row = metadata.get(positionRef);
        if (row ? row.cell.target.kind !== kind || row.cell.target.key !== key : taxMinor !== 0) {
          return refuse("tax_breakdown_incomplete", "/evidence/positions/tax",
            "Supply matching metadata for each assessed money position on its own component.");
        }
        if (row) seen.add(positionRef);
      }
    }
  }
  if (seen.size !== metadata.size) {
    return refuse("tax_breakdown_incomplete", "/evidence/positions/tax", "Remove metadata without a matching money tax position.");
  }

  const fees = new Set(evidence.positions.fees.map(row => row.feeKey));
  if (result.money.fees.length !== fees.size || result.money.fees.some(row => !fees.delete(row.feeKey))) {
    return refuse("tax_breakdown_incomplete", "/evidence/positions/fees", "Supply one metadata row for each calculated fee and remove unmatched rows.");
  }
}
