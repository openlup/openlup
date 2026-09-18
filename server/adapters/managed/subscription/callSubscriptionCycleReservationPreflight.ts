export interface ReservationPreflightSupabaseClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export interface ReservationPreflightResult {
  ok: boolean;
  reason: string | null;
  itemsChecked: number;
  reacquired: number;
}

/**
 * Pre-PSP-charge renewal preflight (docs/platform/RUNTIME_AND_SELF_HOSTING.md §W3b): the 72h
 * subscription_retry_window hold may have expired and been released between
 * the cycle-order creation and a retry charge; the paid pin trigger re-acquires
 * only AFTER payment success. This verifies (and re-acquires via the provider
 * stock authority) BEFORE any money moves — no stock means no charge.
 */
export async function callSubscriptionCycleReservationPreflight(
  client: ReservationPreflightSupabaseClient,
  input: { orderId: string; now: string },
): Promise<ReservationPreflightResult> {
  const { data, error } = await client.rpc("subscription_cycle_reservation_preflight", {
    p_order_id: input.orderId,
    p_now: input.now,
  });
  if (error) throw new Error(`rpc_reservation_preflight: ${error.message ?? "unknown"}`);
  const record = (data ?? {}) as Record<string, unknown>;
  return {
    ok: record.ok === true,
    reason: typeof record.reason === "string" ? record.reason : null,
    itemsChecked: typeof record.itemsChecked === "number" ? record.itemsChecked : 0,
    reacquired: typeof record.reacquired === "number" ? record.reacquired : 0,
  };
}
