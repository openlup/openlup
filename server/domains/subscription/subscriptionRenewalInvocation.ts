import type { PaymentProviderCapabilityRegistry } from "@openlup/core/payment";
import type { VercelRequest } from "../../_lib/types/vercel.js";
import type { SubscriptionRuntimeClock } from "../../../src/domains/subscription/ports.js";
import { resolveSubscriptionPaymentMethodStatus } from "../../../src/domains/subscription/paymentMethodLifecycle.js";
import { chargeSubscriptionCycleOffSession, type ChargeDeps, type DueSubscription,
  type SubscriptionRenewalChargeResult } from "./chargeSubscriptionCycleOffSession.js";
import { RENEWAL_DUNNING_PROPAGATION_FAILED_KEY } from "./propagateSubscriptionCycleChargeFailure.js";
import { isOperatorConfigPreflightReason, isOperatorOnlyPreflightReason,
  isPaymentMethodIntegrityPreflightReason, recordSubscriptionRenewalPreflightBlock } from "./recordSubscriptionRenewalPreflightBlock.js";
import type { SubscriptionRenewalExecutionPortResolution } from "../../runtime/subscription/subscriptionRenewalExecutionPortResolver.js";
import { checkSubscriptionDeliveryAlignmentAdmission } from "./callSubscriptionDeliveryAlignmentAdmission.js";

export const SUBSCRIPTION_RENEWAL_JOB_DRIVER = "vercel_cron";

type SubscriptionRenewalInvocationSource = "vercel_cron" | "manual_smoke" | "github_actions_schedule"
  | "github_actions_dispatch" | "github_actions_poker_schedule" | "github_actions_poker_dispatch" | "unattributed_post";

const ATTRIBUTED_SOURCES = new Set<SubscriptionRenewalInvocationSource>([
  "manual_smoke", "github_actions_schedule", "github_actions_dispatch",
  "github_actions_poker_schedule", "github_actions_poker_dispatch",
]);

export function resolveSubscriptionRenewalInvocation(req: VercelRequest): {
  invocationSource: SubscriptionRenewalInvocationSource;
  invocationRunId: string | null;
} {
  const sourceHeader = req.headers["x-scheduler-source"];
  const source = typeof sourceHeader === "string" ? sourceHeader.trim() : "";
  if (ATTRIBUTED_SOURCES.has(source as SubscriptionRenewalInvocationSource)) {
    if (source === "manual_smoke") return { invocationSource: source, invocationRunId: null };
    const runIdHeader = req.headers["x-scheduler-run-id"];
    const invocationRunId = typeof runIdHeader === "string" ? runIdHeader.trim() : "";
    if (/^[1-9][0-9]{0,19}$/.test(invocationRunId)) {
      return { invocationSource: source as SubscriptionRenewalInvocationSource, invocationRunId };
    }
    return { invocationSource: "unattributed_post", invocationRunId: null };
  }

  // Vercel Cron uses an authenticated GET without observational headers.
  // Unknown POSTs still execute, but they can never become scheduler evidence.
  return req.method === "GET"
    ? { invocationSource: "vercel_cron", invocationRunId: null }
    : { invocationSource: "unattributed_post", invocationRunId: null };
}

export const SUBSCRIPTION_RENEWAL_BATCH_LIMIT = 50;
export const SUBSCRIPTION_RENEWAL_SOFT_BUDGET_MS = 40_000;

interface SubscriptionRenewalDuePort {
  listDue(limit: number, asOf?: Date): Promise<DueSubscription[]>;
}

export interface SubscriptionRenewalBatchDependencies {
  persistence: ChargeDeps["persistence"];
  deliveryAlignment: ChargeDeps["deliveryAlignment"];
  chargeFailurePropagation: ChargeDeps["chargeFailurePropagation"];
  paymentPort: ChargeDeps["paymentPort"];
  duePort: SubscriptionRenewalDuePort;
  resolveExecutionPort: (due: DueSubscription) => SubscriptionRenewalExecutionPortResolution;
  /** Publishes what each rail can do with a stored consent; the charge reads it. */
  capabilities: PaymentProviderCapabilityRegistry;
  clock: SubscriptionRuntimeClock;
  startedAt?: Date; // Clock instant captured at outer invocation start, when applicable.
}

/** The preflight block's slice of the batch deps, spelled once. */
const preflightDeps = (d: SubscriptionRenewalBatchDependencies) =>
  ({ persistence: d.persistence, chargeFailurePropagation: d.chargeFailurePropagation, paymentPort: d.paymentPort });
export interface SubscriptionRenewalBatchSuccess {
  kind: "completed";
  rows: DueSubscription[];
  results: SubscriptionRenewalChargeResult[];
  errors: Array<{ subscription_id: string; reason: string }>;
  rowErrorCounts: Record<string, number>;
  configBlockCounts: Record<string, number>;
  integrityBlockCounts: Record<string, number>;
  deferredByBudget: number;
  startedRows: number;
}

export interface SubscriptionRenewalBatchDueListFailure {
  kind: "due_list_failed";
  reason: string;
}

/**
 * Processes one serial renewal batch. Transport, authorization, and the
 * platform-job lease stay in the caller; time-sensitive renewal work lives here.
 */
export async function runSubscriptionRenewalBatch(
  deps: SubscriptionRenewalBatchDependencies,
): Promise<SubscriptionRenewalBatchSuccess | SubscriptionRenewalBatchDueListFailure> {
  const batchStartedAt = deps.startedAt ?? deps.clock.now();
  let rows: DueSubscription[];
  try {
    rows = await deps.duePort.listDue(SUBSCRIPTION_RENEWAL_BATCH_LIMIT, batchStartedAt);
  } catch (error) {
    return { kind: "due_list_failed", reason: dueListErrorMessage(error) };
  }

  const results: SubscriptionRenewalChargeResult[] = [];
  const errors: Array<{ subscription_id: string; reason: string }> = [];
  const configBlockCounts: Record<string, number> = {};
  const integrityBlockCounts: Record<string, number> = {};
  const rowErrorCounts: Record<string, number> = {};
  let deferredByBudget = 0;
  let startedRows = 0;

  /**
   * Quarantine bookkeeping for one row outcome. A row that fails identically
   * forever is not hypothetical — see {@link stuckRowKey}. Passing `null`
   * records progress and clears the streak; passing a key records a failure,
   * and the RPC parks the cycle behind a capped, self-expiring window from the
   * third IDENTICAL one.
   *
   * Never allowed to fail the row it describes: bookkeeping that can throw is a
   * second way to break the batch it exists to protect.
   */
  const noteRowOutcome = async (due: DueSubscription, errorKey: string | null) => {
    try {
      await deps.persistence.noteRowOutcome({
        subscriptionId: due.subscriptionId,
        scheduledAt: due.nextCycleAt,
        errorKey,
      });
    } catch (bookkeepingError) {
      console.warn("[cron/subscription-renewal] quarantine bookkeeping threw", {
        subscription_id: due.subscriptionId,
        reason: bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError) });
    }
  };

  const recordRowError = async (due: DueSubscription, rowError: unknown) => {
    const reason = rowErrorMessage(rowError);
    const reasonKey = rowErrorReasonKey(reason);
    rowErrorCounts[reasonKey] = (rowErrorCounts[reasonKey] ?? 0) + 1;
    errors.push({ subscription_id: due.subscriptionId, reason });
    console.error("[cron/subscription-renewal] charge failed", { subscription_id: due.subscriptionId, reason });
    // The same normalized key the run ledger counts, so "3 consecutive
    // identical failures" means the same thing to the quarantine as it does to
    // an operator reading `rowErrorCounts`.
    await noteRowOutcome(due, reasonKey);
  };

  for (const [index, due] of rows.entries()) {
    // Admission remains at the row boundary. A started provider attempt stays
    // serial so no second worker can guess at its provider state.
    const rowStartedAt = deps.clock.now();
    if (rowStartedAt.getTime() - batchStartedAt.getTime() >= SUBSCRIPTION_RENEWAL_SOFT_BUDGET_MS) {
      deferredByBudget = rows.length - index;
      break;
    }
    startedRows += 1;

    let deliveryAdmission;
    try {
      const alignment = await checkSubscriptionDeliveryAlignmentAdmission(deps.deliveryAlignment, due, rowStartedAt.toISOString());
      if (alignment.blocked) {
        results.push(alignment.blocked);
        await noteRowOutcome(due, stuckRowKey(alignment.blocked));
        continue;
      }
      deliveryAdmission = alignment.admitted;
    } catch (rowError) {
      await recordRowError(due, rowError);
      continue;
    }

    const executionPort = deps.resolveExecutionPort(due);
    const providerDisabledReason =
      !executionPort.port && isOperatorOnlyPreflightReason(executionPort.reason) && hasExplicitProviderKind(due)
        ? executionPort.reason
        : null;
    const paymentMethod = resolveSubscriptionPaymentMethodStatus(
      {
        clientId: due.clientId,
        methodClientId: due.methodClientId,
        providerKind: due.providerKind,
        providerCustomerRef: due.providerCustomerRef,
        providerMethodRef: due.providerMethodRef,
        methodKind: due.methodKind,
        methodStatus: due.methodStatus,
        methodActive: due.methodActive,
        methodExpiresAt: due.methodExpiresAt,
        payerEmail: due.payerEmail,
      },
      { providerDisabledReason },
    );
    if (!paymentMethod.canAttemptCharge) {
      const reason = paymentMethod.preflightReason ?? "payment_method_invalid";
      countPreflightBlock(reason, configBlockCounts, integrityBlockCounts);
      try {
        const blocked = await recordSubscriptionRenewalPreflightBlock(preflightDeps(deps), due, reason);
        results.push(blocked);
        await noteRowOutcome(due, stuckRowKey(blocked));
      } catch (rowError) {
        await recordRowError(due, rowError);
      }
      continue;
    }

    // A resolved port with no published capability is never guessed at: charging would mean
    // inventing this rail's consent rules. One registry backs both reads, so it cannot happen.
    const capability = executionPort.port ? deps.capabilities.get(due.providerKind) : null;
    if (!executionPort.port || !capability) {
      const reason = executionPort.reason ?? "subscription_provider_not_supported";
      countPreflightBlock(reason, configBlockCounts, integrityBlockCounts);
      try {
        const blocked = await recordSubscriptionRenewalPreflightBlock(preflightDeps(deps), due, reason);
        results.push(blocked);
        await noteRowOutcome(due, stuckRowKey(blocked));
      } catch (rowError) {
        await recordRowError(due, rowError);
      }
      continue;
    }

    try {
      const charged = await chargeSubscriptionCycleOffSession(
        {
          persistence: deps.persistence,
          deliveryAlignment: deps.deliveryAlignment,
          chargeFailurePropagation: deps.chargeFailurePropagation,
          paymentPort: deps.paymentPort,
          executionPort: executionPort.port,
          capability,
          deliveryAlignmentAdmission: deliveryAdmission,
          now: () => deps.clock.now().toISOString(),
        },
        due,
      );
      results.push(charged);
      await noteRowOutcome(due, stuckRowKey(charged));
    } catch (rowError) {
      await recordRowError(due, rowError);
    }
  }

  return {
    kind: "completed",
    rows,
    results,
    errors,
    rowErrorCounts, configBlockCounts, integrityBlockCounts,
    deferredByBudget, startedRows,
  };
}

/**
 * The row-outcome key for a row that did NOT throw — `null` when it progressed.
 * A renewal row has two ways to lie about that.
 *
 * A REPLAYED apply: a row whose apply key is constant for the life of its cycle
 * succeeds every tick as a pure replay, mutates nothing, and is due again in
 * fifteen minutes — the poison pill with its alarm removed: ladder frozen, case
 * never expiring, subscription active and unbilled, logs silent. A FAILED
 * DUNNING PROPAGATION is the same lie from the other end: apply_result DID
 * advance the ladder, so the cycle reads as handled, while the customer has no
 * case, no token and no email. Dunning is checked first, and only ONE key goes
 * out per tick, since the streak advances on IDENTICAL keys. Either way the park
 * is capped at six hours and cleared by the first clean pass — well inside the
 * ladder, which is also what absorbs a genuine recovery replay.
 */
function stuckRowKey(result: SubscriptionRenewalChargeResult): string | null {
  if (result.dunningPropagationFailed === true) return RENEWAL_DUNNING_PROPAGATION_FAILED_KEY;
  return result.applyReplayed === true ? "renewal_apply_replayed_no_progress" : null;
}

function countPreflightBlock(
  reason: string,
  configBlockCounts: Record<string, number>,
  integrityBlockCounts: Record<string, number>,
): void {
  if (isOperatorConfigPreflightReason(reason)) {
    configBlockCounts[reason] = (configBlockCounts[reason] ?? 0) + 1;
  } else if (isPaymentMethodIntegrityPreflightReason(reason)) {
    integrityBlockCounts[reason] = (integrityBlockCounts[reason] ?? 0) + 1;
  }
}

function hasExplicitProviderKind(due: DueSubscription): boolean {
  return due.providerKind.trim().length > 0;
}

function rowErrorReasonKey(message: string): string {
  const tail = message.includes(": ") ? message.slice(message.lastIndexOf(": ") + 2) : message;
  const key = tail.trim().replace(/[,;=]/g, " ").replace(/\s+/g, "_").slice(0, 80);
  return key.length > 0 ? key : "unknown";
}

function dueListErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error);
}
