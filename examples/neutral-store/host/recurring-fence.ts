import { createPostgresNativeCheckoutHostPort } from '@openlup/platform/commerce/server/native-checkout';

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
  return createPostgresNativeCheckoutHostPort(db).isInitialCheckoutOrder(orderId);
}
