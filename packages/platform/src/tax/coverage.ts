import type { TaxCoverageInputV1, TaxCoverageResultV1, TaxRefusal } from "./contracts/index.js";
import { cellKey, compareCells, decide, declarationKey, effectiveDeclarations, includesInstant, sameCell } from "./contracts/identity.js";
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

export function reconcileTaxCoverage(input: TaxCoverageInputV1): TaxCoverageResultV1 {
  const parsed = coverageInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ...evidence([]), ...refuse("tax_invalid_input", parsed.error.field, parsed.error.message) };
  }
  const { scope, coverage, taxDate, required, observations } = parsed.data;
  if (scope.accountRef !== coverage.accountRef) {
    return { ...evidence([]), ...refuse("tax_scope_mismatch", "/coverage/accountRef", "Supply coverage for the selected tax account.") };
  }

  const declarations = effectiveDeclarations(coverage.declarations, taxDate);
  const expected = new Map(required.map(cell => [cellKey(cell), cell]));
  const observed = new Map<string, Observation>();
  const inconsistent: { cell: Cell; field: string; remedy: string }[] = [];
  const rejected = new Set<string>();
  for (const [index, observation] of observations.entries()) {
    const key = cellKey(observation.cell);
    const cell = expected.get(key);
    const remedy = !cell ? "Remove the extra observation. Supply observations for required cells."
      : observed.has(key) || rejected.has(key) ? "Remove the duplicate observation for this required cell."
      : !sameCell(cell, observation.cell) ? "Use the required cell's exact target, level and sourcing metadata."
      : undefined;
    if (remedy) {
      inconsistent.push({ cell: cell ?? observation.cell, field: "/observations/" + index, remedy });
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
    if (decision === "inconsistent") inconsistent.push({
      cell, field: "/observations", remedy: "Reconcile registration, treatment and assessment for the named cell.",
    });
    return { cell, decision, ...(declaration && { declaration }),
      ...(registration && { registration }), ...(treatment && { treatment }) };
  });
  let snapshot: ReturnType<typeof evidence>;
  try { snapshot = evidence(vector); }
  catch {
    return { ...evidence([]), ...refuse("tax_invalid_input", "/required", "Reduce the coverage evaluation to fit the one MiB evidence limit.") };
  }
  const contradiction = inconsistent.sort((a, b) => compareCells(a.cell, b.cell))[0];
  if (contradiction) {
    const { field, remedy, cell } = contradiction;
    return { ...snapshot, ...refuse("tax_coverage_inconsistent", field, remedy, cell) };
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
