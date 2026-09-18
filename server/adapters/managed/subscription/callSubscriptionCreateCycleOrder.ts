/**
 * Wave D-2 — thin TS wrapper around the `subscription_create_cycle_order_with_outbox`
 * RPC. Parses the response shape, strips the `order_` prefix from `orderId`,
 * and surfaces the `replayed` flag so the cron can distinguish a first-time
 * cycle creation from a same-key retry.
 *
 * Kept separate from `chargeSubscriptionCycleOffSession` so the orchestration
 * file stays under the 300 LOC architecture guardrail.
 */

export interface CycleOrderRpcSupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface CallCycleOrderInput {
  idempotencyKey: string;
  subscriptionId: string;
  cycleNumber: number;
  scheduledAt: string;
  templateSnapshot: Record<string, unknown>;
  pricingSnapshot: Record<string, unknown>;
  orderSnapshot: Record<string, unknown>;
}

export interface CycleOrderResult {
  cycleId: string;
  orderRef: string;
  orderUuid: string;
  paymentRef: string;
  replayed: boolean;
}

export async function callSubscriptionCreateCycleOrder(
  client: CycleOrderRpcSupabaseClient,
  input: CallCycleOrderInput,
): Promise<CycleOrderResult> {
  const { data, error } = await client.rpc("subscription_create_cycle_order_with_outbox", {
    p_idempotency_key: input.idempotencyKey,
    p_subscription_id: input.subscriptionId,
    p_cycle_number: input.cycleNumber,
    p_scheduled_at: input.scheduledAt,
    p_template_snapshot: input.templateSnapshot,
    p_pricing_snapshot: input.pricingSnapshot,
    p_order_snapshot: input.orderSnapshot,
  });
  if (error) {
    throw new Error(
      `subscription_create_cycle_order_with_outbox failed: ${error.message ?? "unknown"}`,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("subscription_create_cycle_order_with_outbox returned non-object");
  }
  const body = (data as Record<string, unknown>).subscriptionCycleOrder;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("subscription_create_cycle_order_with_outbox missing subscriptionCycleOrder");
  }
  const cycleId = readString(body as Record<string, unknown>, "cycleId");
  const orderRef = readString(body as Record<string, unknown>, "orderId");
  const paymentRef = readString(body as Record<string, unknown>, "paymentId");
  const orderUuid = orderRef.replace(/^order_/, "");
  const replayed = (body as Record<string, unknown>).replayed === true;
  return { cycleId, orderRef, orderUuid, paymentRef, replayed };
}

function readString(record: Record<string, unknown>, key: string): string {
  const raw = record[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`Subscription cycle order missing ${key}`);
  }
  return raw;
}
