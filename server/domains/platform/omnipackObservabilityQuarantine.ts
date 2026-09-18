import type { OmniPackInboundEventRow } from "./omnipackObservabilityEvidence.js";

export function summarizeRecentOmnipackQuarantines(
  rows: OmniPackInboundEventRow[],
  cutoff: number,
): { stateConflicts: number; other: number } {
  let stateConflicts = 0;
  let other = 0;
  for (const row of rows) {
    if (
      row.provider !== "omnipack" ||
      row.processing_status !== "ignored" ||
      timestamp(row.received_at) < cutoff
    ) continue;
    if (isReconciliationStateConflict(row)) stateConflicts += 1;
    else other += 1;
  }
  return { stateConflicts, other };
}

function isReconciliationStateConflict(row: OmniPackInboundEventRow): boolean {
  const error = row.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const reason = error.reason;
  return typeof reason === "string" && reason.startsWith("omnipack_reconciliation_state_conflict:");
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
