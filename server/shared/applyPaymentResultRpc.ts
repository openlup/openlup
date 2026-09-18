/**
 * Single source for the `commerce_payment_control_apply_result` RPC call.
 *
 * The "apply a payment result" terminal write is one SQL function, but its
 * adapter call (the RPC name + the six `p_*` argument keys) was written out
 * inline at four independent sites across three domains:
 *   - server/adapters/managed/commerce/paymentControlRuntimePort.ts (runtime/rehearsal)
 *   - server/adapters/supabase/payment/paymentWebhook.ts            (webhook, ×2)
 *   - server/domains/subscription/propagateSubscriptionCycleChargeFailure.ts (off-session failure)
 *
 * This helper owns ONLY that shared surface — the argument-contract mapping and
 * the RPC invocation — and returns the client's own `{ data, error }` result
 * untouched. It deliberately does NOT centralise error handling or response
 * extraction, because those legitimately differ per caller and changing them
 * would change behaviour:
 *   - the commerce port classifies the error (`mapRpcError` → conflict/persistence);
 *   - the webhook control port re-throws the RAW error (the webhook handler
 *     regex-matches its message for `23505`/idempotency-conflict → HTTP 409);
 *   - the off-session failure path wraps it in a labelled Error;
 *   - the four response shapes (full paymentResult / subset / `{replayed}` / void)
 *     are each extracted by the caller.
 *
 * Generic over the client's rpc return type so every caller keeps its exact
 * existing error type and downstream handling.
 */
import { classifyPaymentFailure } from "@openlup/core/payment";
import { neutralHintsForPreflightReason } from "../../src/domains/subscription/paymentMethodLifecycle.js";

/**
 * The classification to record when the caller holds no refusal evidence.
 *
 * Lives beside the argument contract because that contract is where "no
 * classification supplied" used to mean "write NULL". For the failures that
 * never reach a payment rail — an off-session SCA block, a preflight refusal against
 * a stored method — the reason key IS the whole evidence, and until this existed
 * those were exactly the failures recorded as unclassified.
 *
 * A supplied classification always wins and cannot lose ground by being kept: it
 * was derived from an advice code or a neutral hint, both of which outrank a
 * reason key in the kernel's own precedence.
 *
 * The derivation hands the classifier the neutral hints the reason's OWNER
 * publishes, not just the key. Half the persisted preflight reasons name the
 * mandate rail in the string itself, and the kernel refuses to guess at those —
 * correctly, since the meaning belongs to the module that emits them. Asking
 * that module for its reading is what lets a renewal blocked on unfit stored
 * consent reach the payer as a cause instead of as silence, while the vendor
 * string still never enters the kernel's own table. A reason its owner says
 * nothing about contributes no hints and classifies exactly as it did before.
 */
export function resolvedFailureClassification(
  supplied: { failureClass: string; decidedBy: string } | null | undefined,
  failureReason: string,
): { failureClass: string; decidedBy: string } {
  return supplied ?? classifyPaymentFailure({
    failureReasonKey: failureReason,
    neutralReasonHints: neutralHintsForPreflightReason(failureReason),
  });
}

export interface ApplyPaymentResultRpcArgs {
  idempotencyKey: string;
  paymentIntentId: string;
  paymentEventId: string | null;
  resultStatus: string;
  occurredAt: string;
  failureReason: string | null;
  /**
   * The refusal's class and the rule that produced it. OPTIONAL, and omitted by
   * every caller that has no provider refusal in hand: the RPC's two parameters
   * default to NULL, so a caller that supplies nothing writes nothing. What the
   * stamped class feeds is DISPLAY: the case's class becomes the customer's cause
   * sentence through the account read model and the recovery page. It is still
   * not a cadence input: nothing in the retry ladder branches on it.
   */
  failureClassification?: { failureClass: string; decidedBy: string } | null;
}

export function applyPaymentResultRpc<T>(
  client: { rpc(functionName: string, args: Record<string, unknown>): PromiseLike<T> },
  args: ApplyPaymentResultRpcArgs,
): PromiseLike<T> {
  return client.rpc("commerce_payment_control_apply_result", {
    p_idempotency_key: args.idempotencyKey,
    p_payment_intent_id: args.paymentIntentId,
    p_payment_event_id: args.paymentEventId,
    p_result_status: args.resultStatus,
    p_occurred_at: args.occurredAt,
    p_failure_reason: args.failureReason,
    p_failure_class: args.failureClassification?.failureClass ?? null,
    p_failure_class_decided_by: args.failureClassification?.decidedBy ?? null,
  });
}
