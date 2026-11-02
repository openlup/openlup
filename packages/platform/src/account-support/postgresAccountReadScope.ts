import type { OperatorQueryExecutor } from "./postgresOperatorAuthority.js";

/** Verified by the host, never populated from an untrusted account request. */
export interface NativeAccountReadScope {
  principalId: string;
  clientId: string;
}
export type NativeAccountRow = Record<string, unknown>;

/** Every read rechecks principal/client ownership, including companion reads by ID. */
export function accountRows(executor: OperatorQueryExecutor, scope: NativeAccountReadScope) {
  for (const id of [scope.principalId, scope.clientId]) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("native_account_scope_invalid");
    }
  }
  const principalId = scope.principalId, clientId = scope.clientId;
  return async (sql: string, values: unknown[] = []): Promise<NativeAccountRow[]> => {
    const result = await executor.query(`WITH owned_clients AS (
      SELECT c.* FROM public.clients c WHERE c.principal_id=$1::uuid AND c.id=$2::uuid
    ), owned_orders AS (
      SELECT o.* FROM public.commerce_orders o JOIN owned_clients c ON c.id=o.client_id
    ), owned_subscriptions AS (
      SELECT s.* FROM public.subscriptions s JOIN owned_clients c ON c.id=s.client_id
    ) SELECT to_jsonb(result) AS row FROM (${sql}) result`, [principalId, clientId, ...values]);
    return result.rows.map(value => record(value.row));
  };
}
export function record(value: unknown): NativeAccountRow {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as NativeAccountRow : {};
}
export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function nullableText(value: unknown): string | null { return text(value) || null; }
export function grouped(rows: NativeAccountRow[], key: string): Map<string, NativeAccountRow[]> {
  const result = new Map<string, NativeAccountRow[]>();
  for (const row of rows) {
    const id = text(row[key]);
    const group = result.get(id) ?? [];
    group.push(row); result.set(id, group);
  }
  return result;
}
export function minor(value: unknown): number {
  const result = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("native_account_money_invalid");
  return result;
}

/** Owned account identity lookup used before composing an account snapshot. */
export async function readPostgresCustomerAccountClient(executor: OperatorQueryExecutor, scope: NativeAccountReadScope): Promise<NativeAccountRow | null> {
  return (await accountRows(executor, scope)("SELECT id,email,first_name,last_name,phone,lifecycle_stage FROM owned_clients"))[0] ?? null;
}

/** An owned order can be paid before any subscription identity exists. */
export interface NativePaidActivationGap { orderId: string; paidAt: string | null }
export interface NativePaidActivationGapReadSource {
  readPaidActivationGaps(orderIds: string[]): Promise<Map<string, NativePaidActivationGap>>;
}
export async function readOwnedPaidActivationGaps(rows: ReturnType<typeof accountRows>, ids: string[]): Promise<Map<string, NativePaidActivationGap>> {
  const result = await rows(`SELECT gap.order_id,gap.paid_at FROM public.subscription_paid_activation_gaps gap
    JOIN owned_orders o ON o.id=gap.order_id AND o.client_id=gap.client_id WHERE o.id=ANY($3::uuid[])
    ORDER BY gap.paid_at DESC,gap.settlement_intent_id DESC`, [ids]);
  return new Map(result.map(row => [text(row.order_id), { orderId: text(row.order_id), paidAt: nullableText(row.paid_at) }]));
}
