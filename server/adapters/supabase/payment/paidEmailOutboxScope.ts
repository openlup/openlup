export type PaidEmailOutboxScopeRow = {
  orderId: string;
  subscriptionId: string | null;
};

export async function readPaidEmailOutboxScope(
  client: unknown,
  paymentIntentId: string,
): Promise<PaidEmailOutboxScopeRow | null> {
  if (!isSupabaseReader(client)) return null;
  const intent = await maybeSingle(client.from("commerce_payment_intents")
    .select("id,order_id,subscription_id")
    .eq("id", paymentIntentId));
  if (!intent) return null;
  const orderId = readNullableString(intent, "order_id");
  if (!orderId) return null;
  const intentSubscriptionId = readNullableString(intent, "subscription_id");
  if (intentSubscriptionId) return { orderId, subscriptionId: intentSubscriptionId };

  const order = await maybeSingle(client.from("commerce_orders")
    .select("id,subscription_id")
    .eq("id", orderId));
  return { orderId, subscriptionId: order ? readNullableString(order, "subscription_id") : null };
}

function isSupabaseReader(client: unknown): client is {
  from(table: string): SupabaseMaybeSingleQuery;
} {
  return !!client && typeof (client as { from?: unknown }).from === "function";
}

interface SupabaseMaybeSingleQuery {
  select(columns: string): SupabaseMaybeSingleQuery;
  eq(column: string, value: unknown): SupabaseMaybeSingleQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown | null }>;
}

async function maybeSingle(builder: SupabaseMaybeSingleQuery): Promise<Record<string, unknown> | null> {
  const { data, error } = await builder.maybeSingle();
  if (error) throw error instanceof Error ? error : new Error("paid_email_dispatch_scope_lookup_failed");
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
