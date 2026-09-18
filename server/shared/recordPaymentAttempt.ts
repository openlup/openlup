import type { PaymentControlRuntimePort } from "../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionResult } from "../../src/domains/payment/types.js";

/**
 * Single mapping from a provider execution result to the payment-control
 * `recordAttempt` RPC port call.
 *
 * Previously this 7-field projection of `PaymentExecutionResult` was written out
 * inline at three independent settlement call-sites (initial checkout in the
 * commerce runtime service, recovery-pay, and the off-session subscription
 * renewal). Behaviour is identical to the inline calls it replaces.
 *
 * The `idempotencyKey` is intentionally CALLER-SUPPLIED, not derived here: each
 * call-site keeps its own exact key string (`:payment-attempt` for checkout and
 * recovery, `:record-attempt` for the subscription cycle), which the payment-
 * control RPC uses for replay/dedup and which the oracle tests pin. Deriving the
 * key inside this helper would change those strings and is a behaviour change.
 *
 * Typed against `Pick<PaymentControlRuntimePort, "recordAttempt">` so any caller
 * can pass its port regardless of which barrel (`runtimePorts.ts` or the
 * `ports.ts` re-export) it imported the type from.
 */
export function recordPaymentAttempt(
  port: Pick<PaymentControlRuntimePort, "recordAttempt">,
  args: { idempotencyKey: string; paymentIntentId: string; execution: PaymentExecutionResult },
): ReturnType<PaymentControlRuntimePort["recordAttempt"]> {
  const { idempotencyKey, paymentIntentId, execution } = args;
  return port.recordAttempt({
    idempotencyKey,
    paymentIntentId,
    provider: execution.provider,
    providerAttemptId: execution.providerAttemptId,
    providerSessionId: execution.providerSessionId,
    attemptStatus: execution.attemptStatus,
    nextActionKind: execution.nextActionKind,
    requestPayload: execution.requestPayload,
    responsePayload: execution.responsePayload,
  });
}
