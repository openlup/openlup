import { CheckoutRecoveryPayError } from './checkoutRecoveryPay.js';
import type { NativeCheckoutRecoveryOrder } from './checkoutRecoveryInspection.js';

export interface CheckoutRecoveryMethodHold { kind: string; method: string; createdAt: string }
/** Host policy supplies method classification, offered methods, hold storage and first-purchase evidence. */
export function withCheckoutRecoveryPaymentHold<Input extends { order: NativeCheckoutRecoveryOrder; method: unknown }, Result>(service: { pay(input: Input): Promise<Result> }, deps: {
  readHolds(): Promise<readonly CheckoutRecoveryMethodHold[]>;
  classify(input: Pick<Input, 'order' | 'method'>): { kind: string; method: string } | null;
  offeredMethods(kind: string): ReadonlySet<string>;
  isFirstPurchase?(order: NativeCheckoutRecoveryOrder): Promise<boolean | null>;
}): { pay(input: Input): Promise<Result> } {
  return { async pay(input) {
    const { order } = input;
    if (order.subscriptionCycleId !== null || order.recreatedFromOrderId || (order.recoveryRootOrderId && order.recoveryRootOrderId !== order.orderId)) return service.pay(input);
    const cell = deps.classify(input);
    if (!cell) return service.pay(input);
    let holds: readonly CheckoutRecoveryMethodHold[];
    try { holds = await deps.readHolds(); } catch { return service.pay(input); }
    const relevant = holds.filter(h => h.kind === cell.kind);
    const held = new Set(relevant.map(h => h.method));
    const offered = [...deps.offeredMethods(cell.kind)];
    if (offered.length && offered.every(m => held.has(m))) return service.pay(input);
    const created = Date.parse(order.createdAt);
    const withheld = relevant.some(h => h.method === cell.method && Number.isFinite(created) && created > Date.parse(h.createdAt));
    if (!withheld) return service.pay(input);
    let first = order.mode === 'one_time_order' && !order.subscriptionId;
    if (!first && deps.isFirstPurchase) {
      try { first = (await deps.isFirstPurchase(order)) === true; } catch { first = false; }
    }
    if (!first) return service.pay(input);
    throw new CheckoutRecoveryPayError('payment_method_withheld', order.orderId, 'conflict');
  } };
}
