import type {
  CommerceReturnsPort,
  ReturnLifecycleResult,
} from "../../domains/commerce/commerceReturnsPort.js";

export interface CommerceReturnsRpcClient {
  rpc(
    fn: string,
    params: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

function parseResult(fn: string, data: unknown): ReturnLifecycleResult {
  const result = (data ?? {}) as Record<string, unknown>;
  if (
    typeof result.returnRequestId !== "string" ||
    typeof result.status !== "string"
  ) {
    throw new Error(`${fn}_unexpected_result`);
  }
  return {
    returnRequestId: result.returnRequestId,
    status: result.status,
    replayed: result.replayed === true,
  };
}

export function createSupabaseCommerceReturnsPort(
  client: CommerceReturnsRpcClient,
): CommerceReturnsPort {
  async function call(
    fn: string,
    params: Record<string, unknown>,
  ): Promise<ReturnLifecycleResult> {
    const { data, error } = await client.rpc(fn, params);
    if (error) throw new Error(`${fn}_failed:${error.code ?? "unknown"}`);
    return parseResult(fn, data);
  }

  return {
    createRequest(input) {
      return call("commerce_return_request_create", {
        p_idempotency_key: input.idempotencyKey,
        p_order_id: input.orderId,
        p_lines: input.lines.map((line) => ({
          orderItemId: line.orderItemId,
          sku: line.sku ?? null,
          quantity: line.quantity,
          restockDisposition: line.restockDisposition ?? "restock",
        })),
        p_reason_code: input.reasonCode,
        p_customer_note: input.customerNote ?? null,
        p_requested_by: input.requestedBy ?? null,
      });
    },
    approve(input) {
      return call("commerce_return_approve", {
        p_idempotency_key: input.idempotencyKey,
        p_return_request_id: input.returnRequestId,
        p_approved_by: input.actorUserId ?? null,
        p_refund_mode: input.refundMode,
        p_refund_amount_cents: input.refundAmountCents ?? null,
        p_admin_note: input.adminNote ?? null,
      });
    },
    reject(input) {
      return call("commerce_return_reject", {
        p_idempotency_key: input.idempotencyKey,
        p_return_request_id: input.returnRequestId,
        p_approved_by: input.actorUserId ?? null,
        p_admin_note: input.adminNote ?? null,
      });
    },
  };
}
