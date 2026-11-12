import { createPostgresSandboxPaymentSimulator } from './postgresSandboxPaymentSimulator.js';
import { paymentPayloadFingerprint } from './paymentTruth.js';
import type { SandboxMethodFacts, SandboxPaymentSimulatorOptions } from './contracts/sandbox.js';

interface Executor { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
/** Neutral attempt-port implementation on the existing synthetic dispatch owner. */
export function createPostgresSandboxCheckoutRecoveryAttemptPort(db: Executor, options: SandboxPaymentSimulatorOptions, now: () => Date = () => new Date()) {
  const simulator = createPostgresSandboxPaymentSimulator(db, options);
  return { async begin(input: {
    order: { orderId: string; totalMinor: number; currency: string };
    clientId: string; recoveryTokenId: string; paymentIntentId: string; idempotencyKey: string; method: SandboxMethodFacts | undefined;
  }) {
    try {
      const attempt = await simulator.beginAttempt({
        settlementIntentId: input.paymentIntentId, idempotencyKey: `${input.idempotencyKey}:payment-execution`,
        requestFingerprint: paymentPayloadFingerprint({ orderId: input.order.orderId, clientId: input.clientId,
          paymentIntentId: input.paymentIntentId, amountMinor: input.order.totalMinor, currency: input.order.currency, method: input.method ?? null }),
        methodFacts: input.method,
        checkoutRecovery: { orderId: input.order.orderId, clientId: input.clientId, recoveryTokenId: input.recoveryTokenId },
        at: now().toISOString(),
      });
      return { orderId: attempt.orderId, paymentIntentId: attempt.settlementIntentId, clientId: input.clientId,
        paymentAttemptId: attempt.id, replayed: attempt.replayed,
        status: attempt.state === 'refused' ? 'failed' as const : attempt.state === 'expired' ? 'expired' as const : 'processing' as const,
        failureReason: attempt.state === 'refused' ? 'generic_decline' : null };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      // Never expose bound values or attach driver details to the public error.
      throw new Error(known.has(code) ? code : 'checkout_recovery_execution_failed');
    }
  } };
}
const known = new Set(['checkout_recovery_authority_invalid', 'checkout_recovery_order_not_recoverable',
  'checkout_recovery_attempt_in_flight', 'payment_simulator_attempt_unresolved', 'payment_simulator_truth_unresolved',
  'payment_simulator_request_conflict', 'payment_simulator_method_facts_invalid', 'native_prepared_attempt_store_unsupported']);
