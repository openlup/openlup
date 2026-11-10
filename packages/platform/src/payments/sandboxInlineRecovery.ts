import { createPostgresSandboxPaymentSimulator } from './postgresSandboxPaymentSimulator.js';
import { paymentPayloadFingerprint } from './paymentTruth.js';
import type { SandboxMethodFacts, SandboxPaymentSimulatorOptions } from './contracts/sandbox.js';
interface Executor { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
/** Register synthetic method identities explicitly. Opaque references never imply a method taxonomy. */
export function createPostgresSandboxInlineRecoveryAttemptPort(db: Executor, options: SandboxPaymentSimulatorOptions & {
  methodKeyFor(facts: SandboxMethodFacts): string | null;
}, now: () => Date = () => new Date()) {
  const simulator = createPostgresSandboxPaymentSimulator(db, options);
  function assertExecutionRail(rail: string) { if (rail !== 'sandbox') throw new Error('native_prepared_attempt_store_unsupported'); }
  return {
    assertExecutionRail,
    async readPreviousMethod(input: { orderId: string; paymentIntentId: string; paymentAttemptId: string; executionRail: string }) {
      assertExecutionRail(input.executionRail);
      const attempt = await simulator.readAttempt({ settlementIntentId: input.paymentIntentId, attemptId: input.paymentAttemptId });
      if (!attempt || attempt.orderId !== input.orderId || attempt.settlementIntentId !== input.paymentIntentId) return null;
      return options.methodKeyFor(attempt.methodFacts);
    },
    async begin(input: { order: { orderId: string }; method: SandboxMethodFacts;
      request: { orderId: string; clientId: string; paymentIntentId: string; expectedPaymentAttemptId: string; retryRequestId: string; executionRail: string; methodKey: string };
      admission: { replayOnly: boolean; purchaseContext: 'one_time' | 'subscription_initial' | null; previousMethodKey: string | null; actions: readonly string[]; restriction: string | null };
    }) {
      const { request, admission } = input;
      assertExecutionRail(request.executionRail);
      const attempt = await simulator.beginAttempt({
        settlementIntentId: request.paymentIntentId,
        idempotencyKey: `checkout-inline-recovery:${request.expectedPaymentAttemptId}:payment-execution:prepare-attempt`,
        // Response replay compares only the nonce and selected rail within this transition.
        requestFingerprint: paymentPayloadFingerprint({ retryRequestId: request.retryRequestId, executionRail: request.executionRail }),
        methodFacts: admission.replayOnly ? undefined : input.method,
        inlineRetry: { orderId: request.orderId, clientId: request.clientId, expectedAttemptId: request.expectedPaymentAttemptId,
          context: { ...admission, retryRequestId: request.retryRequestId, executionRail: request.executionRail,
            requestedMethodKey: request.methodKey, resolvedMethodKey: admission.replayOnly ? null : options.methodKeyFor(input.method) } },
        at: now().toISOString(),
      });
      return { orderId: attempt.orderId, paymentIntentId: attempt.settlementIntentId, clientId: request.clientId,
        paymentAttemptId: attempt.id, executionRail: attempt.settlementChannelKey, replayed: attempt.replayed,
        status: attempt.state === 'refused' ? 'failed' as const : 'processing' as const,
        failureReason: attempt.state === 'refused' ? (attempt as typeof attempt & { failureReason?: string }).failureReason ?? null : null };
    },
  };
}
