import { selectRows, type ObservabilityEvidenceClient } from "./observabilityEvidenceQueries.js";

// Method-health evidence: the read and the summarizer for the standing answer to
// "which subscriptions cannot back their next renewal, and why".
//
// The view (public.subscription_method_health, 20260806175058) classifies every
// active and pending_activation subscription into exactly one health state. Only
// two of those states are actionable, so this module reads only those two and
// leaves `healthy`, `method_missing` and `method_expiring` in the database.
//
// `method_missing` is deliberately NOT read here. The watchdog already pages on
// that population through `activeWithoutPaymentMethodCount`, and a second count
// of the same rows under a new name would be a duplicate pager wearing a
// different dedupe key. `method_expiring` is likewise left out: the column it
// keys on is NULL on every row until the expiry-capture wave lands, so a signal
// on it today would be a permanently silent alert asserting coverage it does
// not have.

/** The two states this module reports; the view's other three are owned elsewhere or not yet meaningful. */
export const METHOD_HEALTH_ACTIONABLE_STATES = ["mandate_not_chargeable_unattended", "activation_gap"] as const;
/** Columns the two counters read; nothing else is selected. */
export const METHOD_HEALTH_COLUMNS = "subscription_id,health_state,narrow_activation_gap";
/**
 * Row cap for the single actionable read.
 *
 * Both signals fire on presence (`count > 0`), so truncation can understate the
 * magnitude in the payload but can never hide a breach — the alert is already
 * firing long before the cap is reached. A head-only exact count per state would
 * cost one query each; one bounded read answers both.
 */
const METHOD_HEALTH_ROW_LIMIT = 2000;

/**
 * When an activation gap stops being a gap and becomes an abandonment.
 *
 * A `pending_activation` subscription is an ordinary state for minutes and a
 * plausible one for hours — the buyer is mid-checkout, or a mandate is being
 * captured. Three days is none of those. The observed worst case had been
 * waiting 38 days while the presence-only p2 counted it without ever raising
 * its voice, which is what an age clock on a presence signal is for.
 */
const ACTIVATION_GAP_OVERDUE_HOURS = 72;

export type MethodHealthEvidenceRow = Record<string, unknown> & {
  subscription_id: string;
  health_state: string;
  narrow_activation_gap?: boolean | null;
  /**
   * When the subscription was created, stamped in by `selectMethodHealthRows`.
   *
   * ⛔ NOT a column of `subscription_method_health`. The view exposes no
   * timestamp at all, and adding one is a full-body view replacement — a
   * migration, for an age this module can obtain with one extra bounded read.
   * `subscriptions.created_at` is the proxy rather than `updated_at`, because
   * `updated_at` is bumped by any writer that touches the row and would reset
   * the clock on exactly the abandoned subscriptions this is meant to find.
   */
  pending_since?: string | null;
};

export interface MethodHealthCounts {
  /**
   * Active subscriptions whose stored mandate declares an autopayment model that
   * cannot be charged unattended. Every one of these is a renewal that will be
   * refused on its due date, counted while there is still time to repair it.
   */
  methodHealthUnchargeableCount: number;
  /**
   * Activation gaps the narrow paid-activation detector does NOT already own.
   *
   * The complement is the point. `subscription_paid_activation_gaps` is narrow
   * by construction (one paid first cycle, one succeeded unattended-eligible
   * activation attempt, exactly one candidate), and the watchdog already pages
   * p1 on it once those rows are four hours overdue. Counting the rows it
   * matches would raise a second pager for one root cause, so they are
   * subtracted here and only the remainder is reported.
   */
  methodHealthActivationGapCount: number;
  /**
   * The subset of the above that has been waiting past
   * `ACTIVATION_GAP_OVERDUE_HOURS`.
   *
   * Deliberately a SUBSET and not a partition: the presence counter keeps
   * counting these rows too. That mirrors how
   * `subscription_active_without_payment_method` (p2) coexists with the p1 it
   * escalates into — the broad signal stays broad, and the narrow one is the
   * one that pages. Splitting them instead would have quietly changed the
   * meaning of a counter that is already wired to a live alert.
   */
  methodHealthActivationGapOverdueCount: number;
}

/**
 * The view's actionable states, plus the age the view cannot express.
 *
 * Two bounded reads rather than one, because the second answers a question the
 * first cannot hold: `subscription_method_health` carries no timestamp, and
 * teaching it one is a migration. The `pending_activation` population is the
 * only one an activation gap can come from, so the second read is narrow by
 * construction and joins in memory on `subscription_id`.
 */
export async function selectMethodHealthRows(
  client: ObservabilityEvidenceClient,
): Promise<MethodHealthEvidenceRow[]> {
  const [rows, pendingActivation] = await Promise.all([
    selectRows<MethodHealthEvidenceRow>(
      client.from<MethodHealthEvidenceRow>("subscription_method_health")
        .select(METHOD_HEALTH_COLUMNS)
        .in("health_state", [...METHOD_HEALTH_ACTIONABLE_STATES])
        .limit(METHOD_HEALTH_ROW_LIMIT),
      "subscription_method_health",
    ),
    // ⛔ `is_test_fixture = false` is not optional here. The column (migration
    // 20260724194500) marks rows that exist to exercise the legacy offer-policy
    // path, and a fixture parked in `pending_activation` would age past 72h
    // forever and hold a p1 open on a subscription no human is waiting for. The
    // detector must page on abandoned CUSTOMERS, not on scaffolding.
    selectRows<{ id: string; created_at?: string | null }>(
      client.from<{ id: string; created_at?: string | null }>("subscriptions")
        .select("id,created_at")
        .eq("status", "pending_activation")
        .eq("is_test_fixture", false)
        .limit(METHOD_HEALTH_ROW_LIMIT),
      "subscriptions_pending_activation",
    ),
  ]);
  const createdAtById = new Map(pendingActivation.map((row) => [row.id, row.created_at ?? null]));
  return rows.map((row) => (
    createdAtById.has(row.subscription_id)
      ? { ...row, pending_since: createdAtById.get(row.subscription_id) ?? null }
      : row
  ));
}

/** Fold the actionable rows into the three counters the evaluator reads. */
export function summarizeMethodHealth(
  rows: readonly MethodHealthEvidenceRow[],
  now: Date = new Date(),
): MethodHealthCounts {
  const overdueCutoff = now.getTime() - ACTIVATION_GAP_OVERDUE_HOURS * 60 * 60 * 1000;
  let methodHealthUnchargeableCount = 0;
  let methodHealthActivationGapCount = 0;
  let methodHealthActivationGapOverdueCount = 0;
  for (const row of rows) {
    if (row.health_state === "mandate_not_chargeable_unattended") {
      methodHealthUnchargeableCount += 1;
      continue;
    }
    // Anything other than an explicit `true` counts as outside the narrow
    // detector: a missing or null flag must not silently suppress the signal.
    if (row.health_state === "activation_gap" && row.narrow_activation_gap !== true) {
      methodHealthActivationGapCount += 1;
      // An unreadable or absent `pending_since` is NOT overdue. The age read is
      // a second query, and a query that failed or was truncated must not be
      // able to invent a p1 — the presence p2 already covers the row either way.
      const pendingSince = row.pending_since ? new Date(row.pending_since).getTime() : Number.NaN;
      if (Number.isFinite(pendingSince) && pendingSince <= overdueCutoff) {
        methodHealthActivationGapOverdueCount += 1;
      }
    }
  }
  return {
    methodHealthUnchargeableCount,
    methodHealthActivationGapCount,
    methodHealthActivationGapOverdueCount,
  };
}
