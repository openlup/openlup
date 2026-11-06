export interface RecoveryQuery {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export const isUuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const sameUuid = (left: unknown, right: unknown) => isUuid(left) && isUuid(right)
  && left.toLowerCase() === right.toLowerCase();

/** Mode is insufficient: initial acquisition can also have a cycle. */
export async function isInitialCheckoutOrder(db: RecoveryQuery, orderId: unknown): Promise<boolean> {
  if (!isUuid(orderId)) return false;
  const row = (await db.query(`SELECT NOT (
      EXISTS (SELECT 1 FROM public.subscription_cycles cycle
        JOIN public.subscription_renewal_operations operation ON operation.id=cycle.renewal_operation_id
        WHERE cycle.id=orders.subscription_cycle_id)
      OR EXISTS (SELECT 1 FROM public.subscription_retry_obligations obligation
        WHERE obligation.order_id=orders.id OR obligation.cycle_id=orders.subscription_cycle_id)
      OR EXISTS (SELECT 1 FROM public.subscription_dunning_cases cases
        WHERE cases.cycle_id=orders.subscription_cycle_id)
    ) AS initial_checkout FROM public.commerce_orders orders WHERE orders.id=$1::uuid`, [orderId])).rows[0];
  return row?.initial_checkout === true;
}
