// Recovered dunning cases, read as STATE rather than as an event.
//
// Why state: the recovery transition happens inside one SQL branch
// (`commerce_payment_control_apply_result` → `..._apply_before_sub_lock`) whose
// returned jsonb is byte-identical to an ordinary success, so no TypeScript
// caller can tell a recovered renewal from a normal one. Scanning the case row
// instead covers EVERY writer that can set `recovered` — customer redeem, cron
// retry via apply_result, reconciliation — without any of them knowing an email
// exists. Adding a fourth writer later costs nothing here.
//
// Named without a vendor on purpose, like `dunningMethodFactsPort`: the client
// is a structural `from(...)` query builder, so the same adapter serves any
// driver that exposes one.
//
// Two queries per run, not per case: the case page, then one batched amount
// read keyed on the scanned ids. The amount is decoration — every unhappy path
// answers null and the copy drops one line; nothing here can block a send.

import type {
  RecoveredDunningCase,
  RecoveredDunningCaseScanPort,
} from "../../../domains/subscription/subscriptionDunningDispatchPorts.js";

interface RecoveredScanQueryBuilder {
  select(columns: string): RecoveredScanQueryBuilder;
  eq(column: string, value: unknown): RecoveredScanQueryBuilder;
  gte(column: string, value: unknown): RecoveredScanQueryBuilder;
  in(column: string, values: readonly unknown[]): RecoveredScanQueryBuilder;
  order(column: string, options: { ascending: boolean }): RecoveredScanQueryBuilder;
  limit(count: number): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export interface RecoveredDunningCaseQueryClient {
  from(table: string): RecoveredScanQueryBuilder;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound on the batched amount read; one row per scanned case at most. */
const AMOUNT_READ_MULTIPLIER = 4;

function readAmounts(rows: Array<Record<string, unknown>>): Map<string, { amountMinor: number | null; currency: string | null }> {
  const byCase = new Map<string, { amountMinor: number | null; currency: string | null }>();
  for (const row of rows) {
    const caseId = row.case_id;
    if (typeof caseId !== "string" || byCase.has(caseId)) continue;
    const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
    const amountMinor = typeof payload.amountMinor === "number" ? payload.amountMinor : null;
    const currency = typeof payload.currency === "string" ? payload.currency : null;
    byCase.set(caseId, { amountMinor, currency });
  }
  return byCase;
}

export function createRecoveredDunningCaseScanPort(
  client: RecoveredDunningCaseQueryClient,
  now: () => number = () => Date.now(),
): RecoveredDunningCaseScanPort {
  return {
    async scanRecovered(windowDays, limit, _signal): Promise<RecoveredDunningCase[]> {
      const from = new Date(now() - windowDays * DAY_MS).toISOString();
      const result = await client
        .from("subscription_dunning_cases")
        .select("id, subscription_id, client_id, recovered_at")
        // Equality, not a NOT-IN list: 'expired', 'cancelled' and 'open' are
        // excluded because they are not this value, so a future fifth status
        // cannot silently start mailing.
        .eq("status", "recovered")
        .gte("recovered_at", from)
        .order("recovered_at", { ascending: true })
        .limit(limit);
      if (result.error) {
        throw new Error(
          `recovered_dunning_scan_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      const rows = Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : [];
      const cases = rows
        .filter((row) =>
          typeof row.id === "string" &&
          typeof row.client_id === "string" &&
          typeof row.recovered_at === "string"
        )
        .map((row) => ({
          caseId: row.id as string,
          subscriptionId: typeof row.subscription_id === "string" ? row.subscription_id : null,
          clientId: row.client_id as string,
          recoveredAt: row.recovered_at as string,
          amountMinor: null as number | null,
          currency: null as string | null,
        }));
      if (cases.length === 0) return cases;

      const amounts = await readCaseAmounts(client, cases.map((row) => row.caseId));
      return cases.map((row) => ({ ...row, ...(amounts.get(row.caseId) ?? {}) }));
    },
  };
}

async function readCaseAmounts(
  client: RecoveredDunningCaseQueryClient,
  caseIds: string[],
): Promise<Map<string, { amountMinor: number | null; currency: string | null }>> {
  try {
    const result = await client
      .from("subscription_dunning_notifications")
      .select("case_id, payload")
      .in("case_id", caseIds)
      .eq("recipient_kind", "customer")
      .order("created_at", { ascending: true })
      .limit(caseIds.length * AMOUNT_READ_MULTIPLIER);
    if (result.error) return new Map();
    return readAmounts(Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : []);
  } catch {
    // The amount is one sentence. A read that throws must not cost the send.
    return new Map();
  }
}
