import { CommerceRuntimePersistenceError } from "../../../../src/domains/commerce/runtimePorts.js";
import type { CheckoutCompensationPort } from "../../../domains/commerce/commerceCheckoutCompensation.js";

export interface CompensationRpcClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string } | null;
  }>;
}

/**
 * Binds both cancellations to one service-role client. Compositions inject the
 * result into the inventory reservation port, so the staying domain module
 * never imports this adapter.
 */
export function createSupabaseCheckoutCompensationAdapter(
  client: CompensationRpcClient,
): Pick<CheckoutCompensationPort, "cancelAbandonedOrder" | "cancelUnstartedPromotionOrder"> {
  return {
    cancelAbandonedOrder: (input) => cancelAbandonedCheckout(client, input),
    cancelUnstartedPromotionOrder: (input) => cancelUnstartedPromotionCheckout(client, input),
  };
}

export async function cancelAbandonedCheckout(
  client: CompensationRpcClient,
  input: Parameters<CheckoutCompensationPort["cancelAbandonedOrder"]>[0],
): Promise<{ cancelled: boolean }> {
  const { data, error } = await client.rpc("commerce_cancel_abandoned_checkout", {
    p_idempotency_key: `${input.idempotencyKey}:abandon`,
    p_order_id: input.orderId,
    p_reason: input.reason,
  });
  if (error) throw new CommerceRuntimePersistenceError("Checkout cancellation RPC failed", { code: error.code });
  return { cancelled: (data as Record<string, unknown> | null)?.cancelled === true };
}

export async function cancelUnstartedPromotionCheckout(
  client: CompensationRpcClient,
  input: Parameters<CheckoutCompensationPort["cancelUnstartedPromotionOrder"]>[0],
): Promise<{ cancelled: boolean }> {
  const { data, error } = await client.rpc("commerce_cancel_unstarted_promotion_order", {
    p_idempotency_key: input.idempotencyKey,
    p_order_id: input.orderId,
    p_reason: input.reason,
  });
  if (error) throw new CommerceRuntimePersistenceError("Promotion cancellation RPC failed", { code: error.code });
  return { cancelled: data === true };
}
