import type { TaxCoverageInputV1, TaxCoverageResultV1, TaxRefusal } from "./contracts/index.js";
import { cellKey, compareCells, declarationKey, includesInstant, sameCell } from "./contracts/identity.js";
import { coverageInputSchema } from "./contracts/schemas.js";
import { taxDigest } from "./digest.js";

type Cell = TaxCoverageInputV1["required"][number];
type Observation = TaxCoverageInputV1["observations"][number];
type Row = TaxCoverageResultV1["vector"][number];

function evidence(vector: TaxCoverageResultV1["vector"]) {
  return { vector, digest: taxDigest("coverage", vector) };
}

function refuse(code: TaxRefusal["code"], field: string, remedy: string, cell?: Cell): TaxRefusal {
  return { kind: "refused", code, field, remedy,
    ...(cell && { jurisdiction: cell.jurisdiction, taxKind: cell.taxKind }) };
}

function decide(
  declaration: Row["declaration"], registration: Row["registration"], treatment: Row["treatment"], amount?: number,
): Row["decision"] {
  if ((amount ?? 0) > 0 && (registration?.state === "inactive" || (treatment && treatment.kind !== "taxable"))) {
    return "inconsistent";
  }
  if (!declaration) return "undeclared";
  if (!registration) return "unavailable_evidence";
  if (declaration.status === "not_registered_acknowledged") {
    return registration.state === "inactive" && treatment?.kind !== "taxable" ? "out_of_scope" : "inconsistent";
  }
  if (registration.state !== "active" || treatment?.kind === "not_applicable") return "inconsistent";
  if (!treatment || amount === undefined) return "unavailable_evidence";
  return treatment.kind === "taxable" ? "in_scope_taxed" : "in_scope_exempt";
}

export function reconcileTaxCoverage(input: TaxCoverageInputV1): TaxCoverageResultV1 {
  const parsed = coverageInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ...evidence([]), ...refuse("tax_invalid_input", parsed.error.field, parsed.error.message) };
  }
  const { scope, coverage, taxDate, required, observations } = parsed.data;
  if (scope.accountRef !== coverage.accountRef) {
    return { ...evidence([]), ...refuse("tax_scope_mismatch", "/coverage/accountRef", "Supply coverage for the selected tax account.") };
  }

  const declarations = new Map(coverage.declarations.filter(entry => includesInstant(entry.effective, taxDate))
    .map(entry => [declarationKey(entry), entry]));
  const expected = new Map(required.map(cell => [cellKey(cell), cell]));
  const observed = new Map<string, Observation>();
  const inconsistent: Cell[] = [];
  const rejected = new Set<string>();
  for (const observation of observations) {
    const key = cellKey(observation.cell);
    const cell = expected.get(key);
    if (!cell || !sameCell(cell, observation.cell) || observed.has(key)) {
      inconsistent.push(cell ?? observation.cell);
      rejected.add(key);
    } else {
      observed.set(key, observation);
    }
  }

  const vector = [...required].sort(compareCells).map((cell): Row => {
    const key = cellKey(cell);
    const declaration = declarations.get(declarationKey(cell));
    if (rejected.has(key)) return { cell, decision: "inconsistent", ...(declaration && { declaration }) };
    const observation = observed.get(key);
    const active = observation?.registration;
    const registration = active && includesInstant(active.effective, taxDate) ? active : undefined;
    const treatment = observation?.treatment;
    const decision = decide(declaration, registration, treatment, observation?.assessedMinor);
    if (decision === "inconsistent") inconsistent.push(cell);
    return { cell, decision, ...(declaration && { declaration }),
      ...(registration && { registration }), ...(treatment && { treatment }) };
  });
  let snapshot: ReturnType<typeof evidence>;
  try { snapshot = evidence(vector); }
  catch {
    return { ...evidence([]), ...refuse("tax_invalid_input", "/required", "Reduce the coverage evaluation to fit the one MiB evidence limit.") };
  }
  const contradiction = inconsistent.sort(compareCells)[0];
  if (contradiction) {
    return { ...snapshot, ...refuse("tax_coverage_inconsistent", "/observations",
      "Reconcile registration, treatment and assessment for the named cell.", contradiction) };
  }
  const undeclared = vector.find(row => row.decision === "undeclared");
  if (undeclared) {
    return { ...snapshot, ...refuse("tax_coverage_undeclared", "/coverage/declarations",
      "Declare the named jurisdiction and tax kind for the tax date.", undeclared.cell) };
  }
  if (vector.some(row => row.decision === "unavailable_evidence")) {
    return { ...snapshot, kind: "unavailable", code: "tax_coverage_evidence_unavailable", effect: "none" };
  }
  return { ...snapshot, kind: "resolved", posting: vector.every(row => row.decision === "out_of_scope") ? "skip" : "required" };
}
