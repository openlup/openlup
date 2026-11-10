import type { CheckoutRecoveryOrderSnapshot, CheckoutRecoveryOrderReadPort } from './checkoutRecoveryOrderPort.js';
import { createExpiredCheckoutRecoveryPolicy } from './checkoutExpiredRecoveryPolicy.js';
import { classifyCheckoutRecoveryTokenState, type CheckoutRecoveryTokenInspection, type CheckoutRecoveryTokenPort } from './checkoutRecoveryToken.js';
import { resolveRecoveryDestination } from '../recoveryDestination.js';

export interface NativeCheckoutRecoveryOrder extends CheckoutRecoveryOrderSnapshot<unknown, string> {
  initialDeclarationId: string | null;
  initialActivationState: string | null;
}
export interface CheckoutRecoveryValidationPort<Order> { validate(order: Order): Promise<boolean> }
/** Adopter-owned content-loss fence. Unsupported snapshots refuse before quoting or other validation work. */
export function createCheckoutRecoveryValidationPolicy<Order>(input: {
  supports(order: Order): boolean;
  validation: CheckoutRecoveryValidationPort<Order>;
}): CheckoutRecoveryValidationPort<Order> {
  return { validate: order => input.supports(order) ? input.validation.validate(order) : Promise.resolve(false) };
}
export type CheckoutRecoveryInspectionPaymentResolution<Action = unknown> =
  | { kind: 'paid' } | { kind: 'retry_new' } | { kind: 'resume_existing'; clientAction: Action }
  | { kind: 'awaiting_provider' } | { kind: 'manual_review' };
export type CheckoutRecoveryInspectionResult<Action = unknown> =
  | { recoverable: false; fallback: 'fresh_checkout' | 'customer_account'; terminalStatus?: 'paid' | 'cancelled' | 'order_changed';
      paidOrder?: { orderId: string; orderRef: string; clientId: string } }
  | { recoverable: true; recoveryKind?: 'retry_existing' | 'recreate_expired';
      order: Pick<NativeCheckoutRecoveryOrder, 'orderId' | 'orderRef' | 'orderNumber' | 'clientId' | 'paymentIntentId' | 'mode' | 'cadenceDays' | 'createdAt'> & { total: { amountMinor: number; currency: string } };
      paymentResolution?: Exclude<CheckoutRecoveryInspectionPaymentResolution<Action>, { kind: 'paid' }> };

/** Read-only presentation. No issuer, writer, attempt starter or payment authority is returned. */
export function createCheckoutRecoveryInspection<Action = unknown>(deps: {
  tokenPort: Pick<CheckoutRecoveryTokenPort, 'validate' | 'inspect'>;
  orderPort: CheckoutRecoveryOrderReadPort<NativeCheckoutRecoveryOrder>;
  validation?: CheckoutRecoveryValidationPort<NativeCheckoutRecoveryOrder>;
  clientHasLiveOrPendingSubscription(input: { clientId: string }): Promise<boolean>;
  paymentResolver?: { resolve(input: { orderId: string; paymentIntentId: string | null; intentStatus?: string | null }): Promise<CheckoutRecoveryInspectionPaymentResolution<Action>> };
  recoveryWindowMs?: number;
  now?: () => Date;
}) {
  const policy = createExpiredCheckoutRecoveryPolicy<NativeCheckoutRecoveryOrder>({ admitsSubscriptionSubject: () => false, recoveryWindowMs: deps.recoveryWindowMs });
  return { async inspect(input: { token: string; capabilities?: readonly string[] }): Promise<CheckoutRecoveryInspectionResult<Action>> {
    const capable = input.capabilities?.includes('recreate_expired_order') === true;
    const resolvePayment = input.capabilities?.includes('resolve_active_payment') === true;
    const fallback = async (context: { clientId: string; mode: string | null; subscriptionId?: string | null } | null,
      terminalStatus?: 'paid' | 'cancelled' | 'order_changed', paid?: NativeCheckoutRecoveryOrder): Promise<CheckoutRecoveryInspectionResult<Action>> => {
      const linked = context?.mode === 'subscription_cycle' || !!context?.subscriptionId;
      const destination = resolveRecoveryDestination({ state: 'unrecoverable', source: 'checkout_recovery',
        hasOrderSubscription: linked, clientHasLiveOrPendingSubscription: !linked && context ? await deps.clientHasLiveOrPendingSubscription({ clientId: context.clientId }) : false });
      return { recoverable: false, fallback: destination === 'fresh_checkout' ? 'fresh_checkout' : 'customer_account',
        ...(terminalStatus ? { terminalStatus } : {}), ...(paid && context && paid.clientId === context.clientId ? {
          paidOrder: { orderId: paid.orderId, orderRef: paid.orderRef, clientId: context.clientId } } : {}) };
    };
    const present = async (order: NativeCheckoutRecoveryOrder, context: CheckoutRecoveryTokenInspection,
      recoveryKind?: 'retry_existing' | 'recreate_expired'): Promise<CheckoutRecoveryInspectionResult<Action>> => {
      const resolution = resolvePayment ? await (deps.paymentResolver?.resolve({ orderId: order.orderId, paymentIntentId: order.paymentIntentId,
        intentStatus: order.paymentIntentStatus }) ?? Promise.resolve({ kind: 'awaiting_provider' } as const)) : undefined;
      if (resolution?.kind === 'paid') {
        const current = await deps.orderPort.getRecoveryOrder({ orderId: order.orderId });
        return fallback(context, 'paid', current?.status === 'paid' ? current : undefined);
      }
      const { orderId, orderRef, orderNumber, clientId, paymentIntentId, mode, cadenceDays, createdAt } = order;
      return { recoverable: true, ...(recoveryKind ? { recoveryKind } : {}),
        order: { orderId, orderRef, orderNumber, clientId, paymentIntentId, mode, cadenceDays, createdAt,
          total: { amountMinor: order.totalMinor, currency: order.currency } }, ...(resolution ? { paymentResolution: resolution } : {}) };
    };
    const validated = await deps.tokenPort.validate(input.token);
    const inspection: CheckoutRecoveryTokenInspection | null = validated ? { ...validated, subscriptionId: null, tokenState: 'active' } : await deps.tokenPort.inspect(input.token);
    if (!inspection || classifyCheckoutRecoveryTokenState(inspection.tokenState) === 'refused') return fallback(inspection);
    const original = await deps.orderPort.getRecoveryOrder({ orderId: inspection.orderId });
    if (!original || original.clientId !== inspection.clientId || original.subscriptionCycleId !== null) return fallback(inspection);
    let order = validated ? original : null;
    if (validated && order?.status === 'pending_payment' && order.paymentIntentId && !order.technicallyExpired) {
      return present(order, inspection, capable ? 'retry_existing' : undefined);
    }
    if (validated && (!order || order.status !== 'pending_payment' || !order.paymentIntentId)) {
      return fallback(order ?? inspection, order?.status === 'paid' ? 'paid' : undefined, order?.status === 'paid' ? order : undefined);
    }
    if (capable && deps.validation) {
      // Re-inspect technical expiry to preserve a revocation that raced validation.
      if (validated) {
        const fresh = await deps.tokenPort.inspect(input.token);
        if (fresh && (fresh.clientId !== inspection.clientId || fresh.orderId !== inspection.orderId || classifyCheckoutRecoveryTokenState(fresh.tokenState) === 'refused')) return fallback(inspection);
        if (fresh) Object.assign(inspection, fresh);
      }
      order = await (deps.orderPort.getLatestRecoveryOrder?.({ orderId: inspection.orderId }) ?? deps.orderPort.getRecoveryOrder({ orderId: inspection.orderId }));
      if (!order || order.clientId !== inspection.clientId || order.subscriptionCycleId !== null) return fallback(inspection);
      if (classifyCheckoutRecoveryTokenState(inspection.tokenState) === 'continuation' && order.status === 'pending_payment' && order.paymentIntentId && !order.technicallyExpired) return present(order, inspection, 'retry_existing');
      if (order.status === 'paid') return fallback(order, 'paid', order);
      // Native initial checkout has a declaration, not a renewal cycle. Apply the
      // unchanged order predicate only after proving its compensated declaration.
      if (order.status === 'cancelled' && !order.technicallyExpired) return fallback(order, 'cancelled');
      const initial = order.mode === 'subscription_cycle';
      if (initial && (!order.initialDeclarationId || order.initialActivationState !== 'compensated')) return fallback(order, 'order_changed');
      const eligibility = policy.classifyExpiredRecovery({ inspection, order: initial ? { ...order, mode: 'one_time_order' } : order, now: deps.now?.() ?? new Date() });
      if (eligibility.kind === 'cancelled') return fallback(order, 'cancelled');
      if (eligibility.kind === 'eligible') return await deps.validation.validate(order) ? present(order, inspection, 'recreate_expired') : fallback(order, 'order_changed');
    }
    if (inspection.status === 'paid') {
      const paid = await deps.orderPort.getRecoveryOrder({ orderId: inspection.orderId });
      return fallback(inspection, 'paid', paid?.status === 'paid' ? paid : undefined);
    }
    return fallback(inspection, order?.status === 'pending_payment' && order.technicallyExpired ? 'order_changed' : undefined);
  } };
}
