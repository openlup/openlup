import { nextRetryAttemptAt } from "@openlup/core/subscription";
import type { RenewalDue, RenewalPaymentRail, RenewalReadback, RenewalSettlementPort, RenewalStorePort } from "./contracts/renewal.js";
import type { AutomaticRenewalPolicy, AutomaticRenewalRunDeps, AutomaticRenewalRunResult, AutomaticRenewalRunStatus } from "./automaticRenewal.js";
/** Recognizes the semantic busy details produced by this module's stock-wait store. */
function isInventoryAdmissionBusy(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("details" in error)) return false;
  const details = error.details;
  return !!details && typeof details === "object" && "code" in details && details.code === "55P03"
    && "reason" in details && ["inventory_admission_busy", "inventory_lock_unavailable"].includes(String(details.reason));
}
export function automaticRenewalResult(operation: RenewalReadback, status: AutomaticRenewalRunStatus, reason: string | null): AutomaticRenewalRunResult {
  return { subscriptionId: operation.subscriptionId, identityKey: operation.identityKey, operationId: operation.operationId, status, replayed: operation.replayed, reason };
}
export async function recoverPreparedExternalAttempt(input: { operation: RenewalReadback; rail: RenewalPaymentRail; settlement: RenewalSettlementPort; occurredAt: string }): Promise<string | null> {
  if (input.operation.externalAttemptRef) return input.operation.externalAttemptRef;
  if (!input.operation.settlementIntentId) return null;
  const externalAttemptRef = await input.rail.findExternalAttempt({ settlementIntentId: input.operation.settlementIntentId });
  if (!externalAttemptRef) return null;
  await input.settlement.acknowledgeExternalAttempt({ operationId: input.operation.operationId, operationFingerprint: input.operation.operationFingerprint, externalAttemptRef, acknowledgedAt: input.occurredAt });
  return externalAttemptRef;
}
export const MAX_RENEWAL_CONCURRENCY = 16;

export function renewalRailRefusal(error: unknown): { reason: "renewal_v3_unavailable"; field: "/rail" } | undefined {
  if (error instanceof Error && "code" in error && error.code === "22023"
    && "detail" in error && error.detail === "/rail" && error.message === "renewal_v3_unavailable") {
    return { reason: "renewal_v3_unavailable", field: "/rail" };
  }
}

export interface RunRenewalBatchOptions {
  /** Bounded per-batch concurrency for normal due renewals (default `1`, max `16`). */
  concurrency?: number;
}

export function normalizeRenewalConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) return 1;
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_RENEWAL_CONCURRENCY) {
    throw new Error("subscription_renewal_concurrency_invalid");
  }
  return concurrency;
}

export async function runRenewalBatchRows(
  due: RenewalDue[],
  run: (row: RenewalDue) => Promise<AutomaticRenewalRunResult>,
  policy: Pick<AutomaticRenewalPolicy, "identityKey">,
  options?: RunRenewalBatchOptions,
): Promise<AutomaticRenewalRunResult[]> {
  const concurrency = normalizeRenewalConcurrency(options?.concurrency);
  const failed = (row: RenewalDue, error: unknown): AutomaticRenewalRunResult => {
    const rail = renewalRailRefusal(error);
    return { subscriptionId: row.subscriptionId, identityKey: policy.identityKey(row), operationId: "",
      status: rail ? "refused" : "error", replayed: false, reason: "renewal_processing_failed", ...rail };
  };
  if (concurrency === 1 || due.length <= 1) {
    const results: AutomaticRenewalRunResult[] = [];
    for (const row of due) {
      try { results.push(await run(row)); }
      catch (error) {
        if (isInventoryAdmissionBusy(error)) continue;
        results.push(failed(row, error));
      }
    }
    return results;
  }

  const slots: Array<AutomaticRenewalRunResult | null> = new Array(due.length).fill(null);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, due.length);
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      if (index >= due.length) return;
      nextIndex = index + 1;
      const row = due[index];
      try {
        slots[index] = await run(row);
      } catch (error) {
        if (isInventoryAdmissionBusy(error)) {
          slots[index] = null;
        } else {
          slots[index] = failed(row, error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return slots.filter((item): item is AutomaticRenewalRunResult => item !== null);
}
export async function refuseRenewalBeforePayment(input: { store: RenewalStorePort; operation: RenewalReadback; reason: string; occurredAt: string }): Promise<AutomaticRenewalRunResult> {
  const refused = await input.store.refuseBeforePayment({ operationId: input.operation.operationId, claimToken: input.operation.claimToken, reason: input.reason, occurredAt: input.occurredAt });
  return automaticRenewalResult(refused, "refused", input.reason);
}
const HANDOFF_OPENS_AT_RETRY_ATTEMPT = 1;
export async function handoffRefusal(deps: AutomaticRenewalRunDeps, operation: RenewalReadback, prepared: { cycleId: string; orderId: string; settlementIntentId: string }, externalAttemptRef: string | null, reason: string, failureClass: string, occurredAt: string): Promise<AutomaticRenewalRunResult> {
  await deps.failureHandoff.handoffFailure({
    idempotencyKey: `${operation.identityKey}:failure-handoff`, subscriptionId: operation.subscriptionId,
    clientId: operation.cycleSnapshot.clientId, cycleId: prepared.cycleId, orderId: prepared.orderId,
    paymentIntentId: prepared.settlementIntentId, retryAttempt: HANDOFF_OPENS_AT_RETRY_ATTEMPT,
    failureClass, failureReason: reason,
    nextRetryAt: nextRetryAttemptAt(occurredAt, HANDOFF_OPENS_AT_RETRY_ATTEMPT, undefined, failureClass),
    occurredAt, amountMinor: operation.cycleSnapshot.pricingSnapshot.totalAmountMinor, currency: operation.cycleSnapshot.pricingSnapshot.currency,
  });
  await deps.settlement.recordTerminalOutcome({ operationId: operation.operationId, eventKey: `${operation.identityKey}:provider-refusal`, operationFingerprint: operation.operationFingerprint, outcome: "refused", externalRef: externalAttemptRef, reason, occurredAt });
  return automaticRenewalResult(operation, "refused", reason);
}
