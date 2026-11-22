import type { TaxCoverageInputV1, TaxCoverageResultV1, TaxCoverageV1 } from "./types.js";

type Cell = TaxCoverageInputV1["required"][number];
type Declaration = TaxCoverageV1["declarations"][number];

function compare(left: readonly string[], right: readonly string[]): number {
  return left.reduce((order, key, i) => order || (key === right[i] ? 0 : key < right[i] ? -1 : 1), 0);
}

function cellTuple(cell: Cell): readonly string[] {
  return [cell.target.kind, cell.target.key, cell.jurisdiction, cell.taxKind];
}

export const cellKey = (cell: Cell): string => JSON.stringify(cellTuple(cell));
export const compareCells = (left: Cell, right: Cell): number => compare(cellTuple(left), cellTuple(right));

export function sameCell(left: Cell, right: Cell): boolean {
  if (cellKey(left) !== cellKey(right) || left.level !== right.level || left.sourcing !== right.sourcing) return false;
  const a = left.target, b = right.target;
  return a.kind !== "fee" || (b.kind === "fee"
    && a.taxClass === b.taxClass && a.assignmentRef === b.assignmentRef && a.deliveryKey === b.deliveryKey);
}

export const declarationKey = (entry: Pick<Declaration, "jurisdiction" | "taxKind">): string =>
  JSON.stringify([entry.jurisdiction, entry.taxKind]);

export const compareDeclarations = (left: Declaration, right: Declaration): number =>
  compare([left.jurisdiction, left.taxKind, left.effective.from], [right.jurisdiction, right.taxKind, right.effective.from]);

export function includesInstant(interval: Declaration["effective"], date: string): boolean {
  return interval.from <= date && (interval.until === undefined || date < interval.until);
}

export function effectiveDeclarations(declarations: TaxCoverageV1["declarations"], taxDate: string) {
  return new Map(declarations.filter(entry => includesInstant(entry.effective, taxDate))
    .map(entry => [declarationKey(entry), entry]));
}

type Row = TaxCoverageResultV1["vector"][number];

export function decide(
  declaration: Row["declaration"], registration: Row["registration"], treatment: Row["treatment"], amount?: number,
): Row["decision"] {
  if ((amount ?? 0) > 0 && (declaration?.status === "not_registered_acknowledged"
    || registration?.state === "inactive" || (treatment && treatment.kind !== "taxable"))) {
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

export function decisionIsPossible(row: Row): boolean {
  // Duplicate or mismatched observations leave only the cell and declaration.
  return (row.decision === "inconsistent" && !row.registration && !row.treatment)
    || [undefined, 0, 1].some(amount => decide(row.declaration, row.registration, row.treatment, amount) === row.decision);
}

export function permitsAssessment(kind: "tax" | "fee", decision: Row["decision"], minor: number): boolean {
  return decision === "in_scope_taxed" || (minor === 0 && (decision === "in_scope_exempt"
    || (kind === "tax" && decision === "out_of_scope")));
}
