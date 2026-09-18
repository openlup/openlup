import {
  consoleOperationalEventRecorder,
  type OperationalEventRecorder,
} from "../_lib/observability/operationalEvents.js";

/**
 * The one place a terminally refused payment becomes an operator signal.
 *
 * ⛔ THERE IS NO SINGLE SEAM IN TYPESCRIPT, WHICH IS WHY THIS HELPER EXISTS.
 * Two different SQL functions record a terminal result —
 * `commerce_payment_control_apply_result` and
 * `commerce_payment_control_apply_reconciliation_result` — reached through four
 * port methods in four adapters. They converge only inside the database, where
 * the reconciliation function delegates to the other one, and a log line cannot
 * be emitted from PL/pgSQL. So the EVENT CONTRACT is centralised here and each
 * adapter contributes the one fact only it holds: whether its own write landed.
 *
 * Every rail that can terminalise a refusal calls this:
 *   1. interactive checkout      → paymentControlRuntimePort.applyResult
 *   2. provider webhook          → paymentWebhook.applyEventResult
 *   3. renewal propagation       → cycleChargeFailurePropagation.applyFailedResult
 *   4. reconciliation cron       → paymentProviderReconciliation.applyTerminalResult
 *   5. verify-now + recovery-pay → the same applyTerminalResult port method
 *
 * Do NOT emit this event anywhere else, and do NOT move it up into
 * `applyPaymentResultRpc`. That helper returns the client's `{ data, error }`
 * untouched and never inspects it, deliberately, so the RPC's own failure is
 * invisible there — emitting from it would announce refusals that were never
 * written, and would still miss the reconciliation rail entirely.
 *
 * Call it AFTER the adapter has proved its write landed, never before.
 */
export interface TerminalPaymentDeclineSignal {
  /** The status the rail applied. Anything but `failed` is silently ignored. */
  resultStatus: string;
  /**
   * TRUE when this write recorded no NEW terminal transition — an idempotent
   * replay, or a correction the control plane declined to apply.
   *
   * The caller decides this because only the caller can read its own RPC's
   * answer, and the two families answer differently: the apply-result family
   * returns `replayed`, while the reconciliation family qualifies that with
   * `correctionStatus`. Suppressing here rather than deduplicating downstream is
   * what keeps a retried cron sweep from re-paging on a refusal that was already
   * reported hours ago.
   */
  replayed: boolean;
  occurredAt: string;
  /**
   * Stable reason KEY, never provider prose. `null` is honest absence.
   */
  failureReason?: string | null;
  /**
   * Absent for the rails that resolve a payment without classifying it
   * (`paymentVerifyNowService`, `checkoutRecoveryPaymentResolver` are pinned
   * classification-absent). Those emit `failureClass: null`, which the
   * dead-method monitor cannot match and the volume monitor therefore owns —
   * the correct reading, since an unclassified refusal is not evidence that the
   * instrument is dead.
   */
  failureClassification?: { failureClass: string; decidedBy: string } | null;
  /**
   * The refusing provider where the seam holds one. Only the reconciliation port
   * carries it; the other three never receive it, and they pass `null` rather
   * than inferring one from the surrounding rail.
   */
  provider?: string | null;
  /** Test seam only. Production callers take the console default on purpose. */
  operationalEvents?: OperationalEventRecorder;
}

export function signalTerminalPaymentDecline(signal: TerminalPaymentDeclineSignal): void {
  const {
    resultStatus,
    replayed,
    occurredAt,
    failureReason,
    failureClassification,
    provider,
    // ⛔ The console rail, not a noop. No port can silence a refusal by
    // forgetting to wire a recorder — silence is the exact failure this seam
    // exists to end, and four call sites is four chances to forget.
    operationalEvents = consoleOperationalEventRecorder,
  } = signal;

  if (resultStatus !== "failed") return;
  if (replayed) return;

  operationalEvents({
    name: "payment_decline_terminal",
    domain: "payment",
    surface: "hidden",
    details: {
      provider: provider ?? null,
      failureClass: failureClassification?.failureClass ?? null,
      failureReason: failureReason ?? null,
      resultStatus: "failed",
      occurredAt,
    },
  });
}
