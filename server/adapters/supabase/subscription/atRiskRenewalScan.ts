// Renewals that are already known to be unchargeable, read as STATE off the
// #2464 view rather than inferred at charge time.
//
// Why the view and not a bespoke query: `subscription_method_health` is the
// standing answer to "which subscriptions will fail their next renewal, and
// why". Its `mandate_not_chargeable_unattended` branch restates in SQL the same
// assessment `readMandateRecurringModel` makes per charge, and the two are held
// equal by pgTAP rather than by one importing the other. Re-deriving that
// predicate here would create a third copy that can drift from both.
//
// Named without a vendor on purpose, like the recovered-case scan beside it: the
// client is a structural `from(...)` query builder, so the same adapter serves
// any driver that exposes one.
//
// Two queries per run, not per row: the health page, then one batched open-case
// read keyed on the scanned subscription ids. The second read SUPPRESSES — a
// subscription already in an open dunning case is receiving dunning mail about
// this very subscription today, and a "your renewal will fail" on top of it
// would be the same news told twice by two rails.

import type {
  AtRiskRenewal,
  AtRiskRenewalScanPort,
} from "../../../domains/subscription/subscriptionDunningDispatchPorts.js";

interface AtRiskScanQueryBuilder {
  select(columns: string): AtRiskScanQueryBuilder;
  eq(column: string, value: unknown): AtRiskScanQueryBuilder;
  in(column: string, values: readonly unknown[]): AtRiskScanQueryBuilder;
  gte(column: string, value: unknown): AtRiskScanQueryBuilder;
  lte(column: string, value: unknown): AtRiskScanQueryBuilder;
  order(column: string, options: { ascending: boolean }): AtRiskScanQueryBuilder;
  limit(count: number): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export interface AtRiskRenewalQueryClient {
  from(table: string): AtRiskScanQueryBuilder;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The two states this rail may mail, by equality on a list rather than by
// excluding the others. `healthy` needs no message; `activation_gap` belongs to
// the activation rail; and `method_expiring` is deliberately absent — expiry
// capture is not deterministic on this deployment yet (`expires_at` is NULL on
// effectively every row, which is why the view treats NULL as "no expiry
// known"), so a warning built on it would be true for a handful of rows and
// silently missing for the rest.
export const AT_RISK_HEALTH_STATES = [
  "mandate_not_chargeable_unattended",
  "method_missing",
] as const;

/** Case statuses that mean "this customer is already in dunning right now". */
const OPEN_DUNNING_STATUS = "open";

export function createAtRiskRenewalScanPort(
  client: AtRiskRenewalQueryClient,
  now: () => number = () => Date.now(),
): AtRiskRenewalScanPort {
  return {
    async scanAtRisk(minDays, maxDays, limit, _signal): Promise<AtRiskRenewal[]> {
      const base = now();
      const from = new Date(base + minDays * DAY_MS).toISOString();
      const to = new Date(base + maxDays * DAY_MS).toISOString();
      const result = await client
        .from("subscription_method_health")
        .select("subscription_id, client_id, next_cycle_at, health_state, narrow_activation_gap")
        // `pending_activation` rows belong to the activation rail and have their
        // own message; this notice is about a RENEWAL.
        .eq("subscription_status", "active")
        // Redundant today — the narrow detector is pending_activation-only, so
        // the predicate above already excludes every marked row — and kept
        // explicit so that widening either predicate cannot silently start
        // double-mailing rows the narrow p1 detector already owns.
        .eq("narrow_activation_gap", false)
        .in("health_state", AT_RISK_HEALTH_STATES)
        .gte("next_cycle_at", from)
        .lte("next_cycle_at", to)
        .order("next_cycle_at", { ascending: true })
        .limit(limit);
      if (result.error) {
        throw new Error(
          `at_risk_renewal_scan_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      const rows = Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : [];
      const candidates = rows
        .filter((row) =>
          typeof row.subscription_id === "string" &&
          typeof row.client_id === "string" &&
          typeof row.next_cycle_at === "string" &&
          typeof row.health_state === "string"
        )
        .map((row) => ({
          subscriptionId: row.subscription_id as string,
          clientId: row.client_id as string,
          nextCycleAt: row.next_cycle_at as string,
          healthState: row.health_state as string,
        }));
      if (candidates.length === 0) return candidates;

      const inDunning = await readOpenDunningSubscriptions(
        client,
        candidates.map((row) => row.subscriptionId),
      );
      return candidates.filter((row) => !inDunning.has(row.subscriptionId));
    },
  };
}

async function readOpenDunningSubscriptions(
  client: AtRiskRenewalQueryClient,
  subscriptionIds: string[],
): Promise<Set<string>> {
  const result = await client
    .from("subscription_dunning_cases")
    .select("subscription_id")
    .eq("status", OPEN_DUNNING_STATUS)
    .in("subscription_id", subscriptionIds)
    .limit(subscriptionIds.length);
  if (result.error) {
    // Fail CLOSED, unlike the recovered scan's amount read. Suppression that
    // silently stops working would mail a customer mid-dunning; a named throw
    // costs this run its at-risk step and retries on the next one.
    throw new Error(
      `at_risk_open_case_read_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
    );
  }
  const rows = Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : [];
  return new Set(
    rows
      .map((row) => row.subscription_id)
      .filter((value): value is string => typeof value === "string"),
  );
}
