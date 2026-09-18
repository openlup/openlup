// Retention drain for the customer diagnostic history: the application-owned
// core behind the existing `prune` port (ADR 003 — the provider only triggers,
// hosts or sits behind the adapter).
//
// `customer_diagnostic_prune_v1(p_batch_size)` takes one argument, returns the
// four deletion counters and nothing else: there is no `morePossible` column to
// relay. The loop below derives it, which is why the decision lives here rather
// than in an adapter that would have to invent a field the SQL never returns.

/** The ledger identity of this job, shared by its runtime and the ingest gate. */
export const CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME = "customer-diagnostic-prune";

/** `customer_diagnostic_prune_v1` raises `customer_diagnostic_prune_invalid` outside [1,500]. */
export const CUSTOMER_DIAGNOSTIC_PRUNE_MIN_BATCH_SIZE = 1;
export const CUSTOMER_DIAGNOSTIC_PRUNE_MAX_BATCH_SIZE = 500;
export const CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_BATCH_SIZE = 500;
export const CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_MAX_BATCHES = 12;
export const CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_TIME_BUDGET_MS = 45_000;

export interface CustomerDiagnosticPruneCounts {
  eventsDeleted: number;
  segmentsDeleted: number;
  limitsDeleted: number;
  accessDeleted: number;
}

/** The single port method this job needs; the history port already carries it. */
export interface CustomerDiagnosticPrunePort {
  prune(batchSize: number): Promise<CustomerDiagnosticPruneCounts>;
}

export interface CustomerDiagnosticPruneSummary extends CustomerDiagnosticPruneCounts {
  batchSize: number;
  batches: number;
  deleted: number;
  /** Derived here: a saturated last batch, or a loop the budget stopped. */
  morePossible: boolean;
}

export interface CustomerDiagnosticPruneInput {
  port: CustomerDiagnosticPrunePort;
  batchSize?: number;
  maxBatches?: number;
  /** Wall-clock budget; the hosted route's `maxDuration` is 60s. */
  timeBudgetMs?: number;
  now?: () => number;
}

/**
 * A batch size outside the RPC's accepted range is clamped rather than sent:
 * the refusal is `customer_diagnostic_prune_invalid`, which would fail the run
 * without deleting anything, and no caller gains from that.
 */
export function clampCustomerDiagnosticPruneBatchSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_BATCH_SIZE;
  }
  const truncated = Math.trunc(requested);
  if (truncated < CUSTOMER_DIAGNOSTIC_PRUNE_MIN_BATCH_SIZE) return CUSTOMER_DIAGNOSTIC_PRUNE_MIN_BATCH_SIZE;
  if (truncated > CUSTOMER_DIAGNOSTIC_PRUNE_MAX_BATCH_SIZE) return CUSTOMER_DIAGNOSTIC_PRUNE_MAX_BATCH_SIZE;
  return truncated;
}

/**
 * Delete expired diagnostic rows in bounded batches.
 *
 * Stops on the first batch that does not fill `batchSize` in any lane (nothing
 * more is due), on the batch budget, or on the time budget. A failing lane is
 * never swallowed: the caller owns the ledger and must record the run failed.
 */
export async function pruneCustomerDiagnosticHistory(
  input: CustomerDiagnosticPruneInput,
): Promise<CustomerDiagnosticPruneSummary> {
  const batchSize = clampCustomerDiagnosticPruneBatchSize(input.batchSize);
  const maxBatches = Math.max(1, Math.trunc(input.maxBatches ?? CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_MAX_BATCHES));
  const timeBudgetMs = Math.max(0, input.timeBudgetMs ?? CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_TIME_BUDGET_MS);
  const now = input.now ?? (() => Date.now());
  const startedAt = now();

  const totals: CustomerDiagnosticPruneCounts = {
    eventsDeleted: 0,
    segmentsDeleted: 0,
    limitsDeleted: 0,
    accessDeleted: 0,
  };
  let batches = 0;
  let morePossible = false;

  while (batches < maxBatches) {
    const counts = await input.port.prune(batchSize);
    batches += 1;
    totals.eventsDeleted += counts.eventsDeleted;
    totals.segmentsDeleted += counts.segmentsDeleted;
    totals.limitsDeleted += counts.limitsDeleted;
    totals.accessDeleted += counts.accessDeleted;

    if (!isSaturated(counts, batchSize)) {
      morePossible = false;
      break;
    }
    // A lane that filled its batch may still have rows behind it. That stays
    // true if the next iteration never happens because a budget ended the loop.
    morePossible = true;
    if (now() - startedAt >= timeBudgetMs) break;
  }

  return {
    ...totals,
    batchSize,
    batches,
    deleted: totalDeleted(totals),
    morePossible,
  };
}

function isSaturated(counts: CustomerDiagnosticPruneCounts, batchSize: number): boolean {
  return laneCounts(counts).some((count) => count >= batchSize);
}

function totalDeleted(counts: CustomerDiagnosticPruneCounts): number {
  return laneCounts(counts).reduce((sum, count) => sum + count, 0);
}

function laneCounts(counts: CustomerDiagnosticPruneCounts): number[] {
  return [counts.eventsDeleted, counts.segmentsDeleted, counts.limitsDeleted, counts.accessDeleted];
}
