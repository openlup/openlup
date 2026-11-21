import type { TaxCoverageInputV1, TaxCoverageV1 } from "./types.js";

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
