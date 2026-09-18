import type {
  SubscriptionRenewalChargeResult,
} from "../../server/domains/subscription/chargeSubscriptionCycleOffSession.js";

export function summariseRenewalResults(
  results: SubscriptionRenewalChargeResult[],
  errors: Array<{ subscription_id: string; reason: string }>,
): {
  processed: number;
  charged: number;
  requires_action: number;
  failed: number;
  skipped: number;
  errors: number;
  dunning_cases_opened: number;
} {
  let charged = 0;
  let requiresAction = 0;
  let failed = 0;
  let skipped = 0;
  let dunning = 0;
  for (const r of results) {
    if (r.outcome === "charged") charged += 1;
    else if (r.outcome === "requires_action") requiresAction += 1;
    else if (r.outcome === "skipped") skipped += 1;
    else failed += 1;
    if (r.dunningCaseId) dunning += 1;
  }
  return {
    processed: results.length,
    charged,
    requires_action: requiresAction,
    failed,
    skipped,
    errors: errors.length,
    dunning_cases_opened: dunning,
  };
}

export function buildRenewalBudgetFailureResponse(input: {
  released: boolean;
  exhaustedBeforeFirstRow: boolean;
  scanned: number;
  startedRows: number;
  deferredByBudget: number;
  aggregation: ReturnType<typeof summariseRenewalResults>;
}): { status: 409 | 503; body: Record<string, unknown> } | null {
  const base = {
    ok: false,
    scanned: input.scanned,
    startedRows: input.startedRows,
    deferredByBudget: input.deferredByBudget,
    ...input.aggregation,
  };
  if (!input.released) {
    return { status: 409, body: { ...base, error: "renewal_lease_lost" } };
  }
  if (input.exhaustedBeforeFirstRow) {
    return { status: 503, body: { ...base, error: "renewal_budget_exhausted_before_work" } };
  }
  return null;
}

export function buildRenewalRunReason(
  rowErrorCounts: Record<string, number>,
  configBlockCounts: Record<string, number>,
  integrityBlockCounts: Record<string, number> = {},
): string | undefined {
  const parts: string[] = [];
  if (Object.keys(configBlockCounts).length > 0) {
    parts.push(`provider_config_blocked:${formatReasonCounts(configBlockCounts)}`);
  }
  if (Object.keys(integrityBlockCounts).length > 0) {
    parts.push(`payment_integrity_blocked:${formatReasonCounts(integrityBlockCounts)}`);
  }
  if (Object.keys(rowErrorCounts).length > 0) {
    parts.push(`row_errors:${formatReasonCounts(rowErrorCounts)}`);
  }
  return parts.length > 0 ? parts.join(";") : undefined;
}

export function rowErrorReasonKey(message: string): string {
  const tail = message.includes(": ") ? message.slice(message.lastIndexOf(": ") + 2) : message;
  const key = tail.trim().replace(/[,;=]/g, " ").replace(/\s+/g, "_").slice(0, 80);
  return key.length > 0 ? key : "unknown";
}

function formatReasonCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");
}
