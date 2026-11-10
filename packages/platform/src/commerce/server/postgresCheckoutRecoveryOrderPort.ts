import { z } from 'zod';
import type { CheckoutRecoveryOrderReadPort } from './checkoutRecoveryOrderPort.js';
import type { NativeCheckoutRecoveryOrder } from './checkoutRecoveryInspection.js';

export interface CheckoutRecoveryReadExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const nullableText = z.string().min(1).nullable();
const snapshot = z.object({
  orderId: z.guid(), orderRef: z.string().min(1), orderNumber: z.string().min(1), clientId: z.guid(), status: z.string().min(1),
  mode: z.enum(['one_time_order', 'subscription_cycle']), totalMinor: z.number().int().safe().nonnegative(), currency: z.string().min(1),
  createdAt: z.string().refine(value => Number.isFinite(Date.parse(value))), cadenceDays: z.number().int().positive().nullable(),
  customerEmail: nullableText, customerName: nullableText, paymentIntentId: z.guid().nullable(), paymentIntentStatus: nullableText,
  subscriptionId: z.guid().nullable(), subscriptionCycleId: z.guid().nullable(), shippingAddressId: z.guid().nullable(),
  initialDeclarationId: z.guid().nullable(), initialActivationState: nullableText,
  quoteSnapshot: z.unknown().nullable(), runtimeMetadata: z.record(z.string(), z.unknown()), invoiceBuyerSnapshot: z.record(z.string(), z.unknown()),
  recoveryRootOrderId: z.guid(), recreatedFromOrderId: z.guid().nullable(), technicallyExpired: z.boolean().nullable(),
});
/** Service-only reader. The caller must bind the result to validated/inspected bearer ownership. */
export function createPostgresCheckoutRecoveryOrderPort(executor: CheckoutRecoveryReadExecutor): CheckoutRecoveryOrderReadPort<NativeCheckoutRecoveryOrder> {
  async function read(sql: string, orderId: string): Promise<NativeCheckoutRecoveryOrder | null> {
    const row = (await executor.query(sql, [orderId])).rows[0];
    if (!row || !Object.hasOwn(row, 'result')) throw new Error('checkout_recovery_snapshot_invalid');
    if (row.result === null) return null;
    const value = snapshot.safeParse(row.result);
    if (!value.success) throw new Error('checkout_recovery_snapshot_invalid');
    return { ...value.data, technicallyExpired: value.data.technicallyExpired === true };
  }
  return {
    getRecoveryOrder: ({ orderId }) => read('SELECT public.commerce_checkout_recovery_order_snapshot($1::uuid) AS result', orderId),
    getLatestRecoveryOrder: ({ orderId }) => read('SELECT public.commerce_checkout_recovery_latest_order_snapshot($1::uuid) AS result', orderId),
  };
}
