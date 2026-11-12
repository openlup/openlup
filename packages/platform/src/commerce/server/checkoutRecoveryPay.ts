import type { NativeCheckoutRecoveryOrder } from './checkoutRecoveryInspection.js';
import type { CheckoutRecoveryOrderReadPort } from './checkoutRecoveryOrderPort.js';
import { classifyCheckoutRecoveryTokenState, type CheckoutRecoveryTokenPort } from './checkoutRecoveryToken.js';

export interface CheckoutRecoveryPayInput<Method> {
  order: NativeCheckoutRecoveryOrder;
  clientId: string;
  recoveryTokenId: string;
  idempotencyKey: string;
  method: Method;
}
export interface CheckoutRecoveryPayResult {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
  paymentAttemptId: string;
  status: 'processing' | 'failed' | 'expired' | 'paid';
  replayed: boolean;
  failureReason: string | null;
}
/** The adapter owns durable dispatch, exact request/method binding and settlement evidence. */
export interface CheckoutRecoveryAttemptPort<Method> {
  begin(input: CheckoutRecoveryPayInput<Method> & { paymentIntentId: string }): Promise<CheckoutRecoveryPayResult>;
}
export interface CheckoutRecoveryPayService<Method> {
  pay(input: CheckoutRecoveryPayInput<Method>): Promise<CheckoutRecoveryPayResult>;
}
export class CheckoutRecoveryPayError extends Error {
  constructor(readonly code: string, readonly orderId: string, readonly kind: 'conflict' | 'upstream_unavailable') {
    super(`checkout_recovery_pay_${code}`); this.name = 'CheckoutRecoveryPayError';
  }
}
/** Existing order, intent and reservation only. No order creation or settlement shortcut. */
export function createCheckoutRecoveryPayService<Method>(attemptPort: CheckoutRecoveryAttemptPort<Method>): CheckoutRecoveryPayService<Method> {
  return { async pay(input) {
    const { order } = input;
    if (order.clientId !== input.clientId || order.subscriptionCycleId !== null || order.status !== 'pending_payment' || order.technicallyExpired) {
      throw new CheckoutRecoveryPayError('order_not_recoverable', order.orderId, 'conflict');
    }
    if (!order.paymentIntentId) throw new CheckoutRecoveryPayError('no_open_intent', order.orderId, 'conflict');
    if (order.paymentIntentStatus !== 'created' && order.paymentIntentStatus !== 'pending' && order.paymentIntentStatus !== 'failed') {
      throw new CheckoutRecoveryPayError('payment_intent_in_flight', order.orderId, 'upstream_unavailable');
    }
    try { return await attemptPort.begin({ ...input, paymentIntentId: order.paymentIntentId }); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'checkout_recovery_authority_invalid') throw new CheckoutRecoveryPayError('token_expired_or_consumed', order.orderId, 'conflict');
      if (code === 'checkout_recovery_order_not_recoverable') throw new CheckoutRecoveryPayError('order_not_recoverable', order.orderId, 'conflict');
      if (code === 'native_prepared_attempt_store_unsupported') throw new CheckoutRecoveryPayError(code, order.orderId, 'upstream_unavailable');
      if (['checkout_recovery_attempt_in_flight', 'payment_simulator_attempt_unresolved', 'payment_simulator_truth_unresolved'].includes(code)) {
        throw new CheckoutRecoveryPayError('provider_attempt_in_flight', order.orderId, 'upstream_unavailable');
      }
      throw new CheckoutRecoveryPayError('provider_execution_failed', order.orderId, 'upstream_unavailable');
    }
  } };
}

/** Authority is token-derived; caller-supplied order/client identities are never accepted. */
export function createCheckoutRecoveryTokenPay<Method>(deps: {
  tokenPort: Pick<CheckoutRecoveryTokenPort, 'validate' | 'inspect'>;
  orderPort: CheckoutRecoveryOrderReadPort<NativeCheckoutRecoveryOrder>;
  payService: CheckoutRecoveryPayService<Method>;
}) {
  return { async pay(input: { token: string; idempotencyKey: string; method: Method; followLatest?: boolean }) {
    const validated = await deps.tokenPort.validate(input.token);
    const inspected = input.followLatest ? await deps.tokenPort.inspect(input.token) : null;
    if ((!validated && !inspected) || (inspected && classifyCheckoutRecoveryTokenState(inspected.tokenState) !== 'continuation')) {
      throw new CheckoutRecoveryPayError('token_expired_or_consumed', '', 'conflict');
    }
    const context = inspected ?? validated!;
    const original = await deps.orderPort.getRecoveryOrder({ orderId: context.orderId });
    if (!original || original.clientId !== context.clientId || original.subscriptionCycleId !== null) {
      throw new CheckoutRecoveryPayError('order_not_recoverable', context.orderId, 'conflict');
    }
    const order = input.followLatest && deps.orderPort.getLatestRecoveryOrder
      ? await deps.orderPort.getLatestRecoveryOrder({ orderId: context.orderId }) : original;
    if (!order || order.clientId !== context.clientId) throw new CheckoutRecoveryPayError('order_not_recoverable', context.orderId, 'conflict');
    return deps.payService.pay({ order, clientId: context.clientId, recoveryTokenId: context.tokenId, idempotencyKey: input.idempotencyKey, method: input.method });
  } };
}
