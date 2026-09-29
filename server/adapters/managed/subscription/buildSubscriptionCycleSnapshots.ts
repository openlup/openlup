import { resolveSubscriptionCycleIdentity } from "./resolveSubscriptionCycleIdentity.js";
import { loadSubscriptionCycleLines, type QuoteLine } from "./subscriptionCycleLines.js";
import {
  starterGraduationFailureMessage,
  type StarterPackCyclePort, type StarterPackCyclePreparation,
} from "../../../domains/subscription/starterPackCycle.js";
import {
  buildOrderSnapshot,
  buildPricingSnapshot,
} from "../../../domains/subscription/subscriptionCycleOrderTotals.js";

/**
 * Wave D-2 — builds the three jsonb snapshots that
 * `subscription_create_cycle_order_with_outbox` requires for an off-session
 * renewal cycle.
 *
 * - `templateSnapshot` is sourced from `subscription_current_template_snapshot`
 *   RPC so the result matches the trigger guard byte-for-byte.
 * - `pricingSnapshot` + `orderSnapshot` are reconstructed in TS from the
 *   `subscription_lines.line_metadata.productSnapshot.quoteLine` field that
 *   the initial-activation RPC froze at checkout time. We deliberately do
 *   NOT re-invoke the quote engine in D-2 — renewals are charged at the
 *   activation-time price. Re-pricing belongs in a follow-up wave.
 * - the money builders themselves live in `subscriptionCycleOrderTotals.ts`.
 *
 * A starter-pack subscription adds one step, taken through the neutral
 * `StarterPackCyclePort` the caller composes onto the client: it derives the
 * acquisition phase from the immutable marker and either supplies delivery 2's
 * discount or applies the graduation. When graduation runs it rewrites the
 * template and the lines, so both are re-read afterwards and the snapshots are
 * built from the graduated package.
 *
 * Outputs are deterministic given `(subscriptionId, scheduledAt)`: lines are
 * sorted by `sort_order, variant_id`, totals are integer sums of the line
 * subtotals, and the scheduled timestamp is the one the caller supplies. That
 * keeps the MD5 fingerprint inside the cycle-order RPC stable across cron
 * retries.
 */

export interface SubscriptionCycleSnapshotInput {
  subscriptionId: string;
  scheduledAt: string;
}

export interface SubscriptionCycleSnapshotResult {
  cycleNumber: number;
  /**
   * Cycle's current `retry_attempt` (0 = new; the prior `apply_result`'s value
   * on a `retry_scheduled` re-drive). Lets the orchestrator mint a fresh
   * per-attempt provider key — Stripe rejects reusing a declined attempt's key
   * with a re-bound card (CJ01-P).
   */
  retryAttempt: number;
  /**
   * Provider execution sequence independent from customer dunning retries.
   * Zero preserves the historic provider key; positive values are created only
   * after operator-confirmed prepared/no-ack remediation.
   */
  providerAttemptSequence: number;
  templateSnapshot: Record<string, unknown>;
  pricingSnapshot: Record<string, unknown>;
  orderSnapshot: Record<string, unknown>;
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
}

interface SnapshotQueryResult {
  data: unknown;
  error: RpcError | null;
}

interface SnapshotQueryBuilder extends PromiseLike<SnapshotQueryResult> {
  select(columns: string): SnapshotQueryBuilder;
  eq(column: string, value: unknown): SnapshotQueryBuilder;
  order(column: string, options?: { ascending?: boolean }): SnapshotQueryBuilder;
}

export interface SnapshotSupabaseClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<SnapshotQueryResult>;
  from(table: string): SnapshotQueryBuilder;
}

/**
 * The snapshot builder's store plus the neutral starter-pack cycle operations,
 * composed onto it the same way the delivery-alignment admission is. The
 * managed composition assigns
 * `createStarterPackCyclePort(client)` from
 * `server/adapters/supabase/subscription/starterPackCycle.ts`.
 */
export type SubscriptionCycleSnapshotClient = SnapshotSupabaseClient & StarterPackCyclePort;

export class SubscriptionCycleSnapshotError extends Error {
  readonly subscriptionId: string;
  readonly cause?: unknown;

  constructor(message: string, subscriptionId: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SubscriptionCycleSnapshotError";
    this.subscriptionId = subscriptionId;
    this.cause = options?.cause;
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

export async function buildSubscriptionCycleSnapshots(
  client: SubscriptionCycleSnapshotClient,
  input: SubscriptionCycleSnapshotInput,
): Promise<SubscriptionCycleSnapshotResult> {
  // Start independent snapshot inputs together, then preserve the old
  // template → lines → cycle-identity error precedence while consuming them.
  const templateSnapshotPromise = loadTemplateSnapshot(client, input.subscriptionId);
  const linesPromise = loadSubscriptionCycleLines(client, input.subscriptionId);
  const identityPromise = resolveSubscriptionCycleIdentity(
    client,
    input.subscriptionId,
    input.scheduledAt,
  );
  const starterStatePromise = client.loadStarterPackState(input.subscriptionId);
  const [templateSnapshotResult, linesResult, identityResult, starterStateResult] =
    await Promise.allSettled([
      templateSnapshotPromise,
      linesPromise,
      identityPromise,
      starterStatePromise,
    ]);
  let templateSnapshot = settledValue(templateSnapshotResult);
  let { lines, listAnchorMinor } = settledValue(linesResult);
  const { cycleNumber, retryAttempt, providerAttemptSequence } = settledValue(identityResult);
  const starterState = settledValue(starterStateResult);

  let starter: StarterPackCyclePreparation;
  try {
    starter = await client.prepareStarterPackCycle({
      subscriptionId: input.subscriptionId, cycleNumber, state: starterState,
      subtotalMinor: subtotalGrossMinor(lines),
      listAnchorMinor,
    });
  } catch (error) {
    // Rethrow, never swallow: fail-closed is the point. All this adds is the
    // attribution — which subscription, which raised condition — so the run
    // ledger names the failure instead of carrying a transport message.
    throw new SubscriptionCycleSnapshotError(
      starterGraduationFailureMessage(input.subscriptionId, error), input.subscriptionId,
      { cause: error });
  }
  if (starter.reload) {
    // Graduation rewrote cadence and the non-addon template lines; the values
    // read above describe the package that no longer exists.
    // Graduation rewrote the lines; the list anchor of the old ones is spent.
    const [reloadedTemplate, reloaded] = await Promise.all([
      loadTemplateSnapshot(client, input.subscriptionId),
      loadSubscriptionCycleLines(client, input.subscriptionId),
    ]);
    templateSnapshot = reloadedTemplate;
    lines = reloaded.lines;
  }
  const currency = readString(templateSnapshot, "currency");

  const orderSnapshot = buildOrderSnapshot({
    currency,
    lines,
    discountTotalGrossMinor: starter.discountTotalGrossMinor,
  });
  const pricingSnapshot = buildPricingSnapshot({
    subscriptionId: input.subscriptionId,
    scheduledAt: input.scheduledAt,
    cycleNumber,
    totals: orderSnapshot.totals as Record<string, unknown>,
    provenance: starter.provenance,
  });

  return {
    cycleNumber,
    retryAttempt,
    providerAttemptSequence,
    templateSnapshot,
    pricingSnapshot,
    orderSnapshot,
  };
}

function subtotalGrossMinor(lines: QuoteLine[]): number {
  return lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0);
}

async function loadTemplateSnapshot(
  client: SnapshotSupabaseClient,
  subscriptionId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("subscription_current_template_snapshot", {
    p_subscription_id: subscriptionId,
  });
  if (error) {
    throw new SubscriptionCycleSnapshotError(
      `subscription_current_template_snapshot failed: ${error.message ?? "unknown"}`,
      subscriptionId,
      { cause: error },
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SubscriptionCycleSnapshotError(
      "subscription_current_template_snapshot returned non-object",
      subscriptionId,
    );
  }
  return data as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const raw = record[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`Snapshot field ${key} missing or invalid`);
  }
  return raw;
}
