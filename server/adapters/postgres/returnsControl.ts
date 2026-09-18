import type {
  CommerceReturnsPort,
  ReturnLifecycleResult,
} from "../../domains/commerce/commerceReturnsPort.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

export function createPostgresCommerceReturnsPort(
  executor: PgQueryExecutor,
): CommerceReturnsPort {
  const call = async (
    functionName: string,
    args: Record<string, unknown>,
  ): Promise<ReturnLifecycleResult> => {
    const keys = Object.keys(args);
    const namedArgs = keys
      .map((key, index) => `"${key}" => $${index + 1}`)
      .join(", ");
    const { rows } = await executor.query(
      `SELECT ${functionName}(${namedArgs}) AS value`,
      keys.map((key) => parameter(args[key])),
    );
    const value = rows[0]?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${functionName}_unexpected_result`);
    }
    const result = value as Record<string, unknown>;
    if (
      typeof result.returnRequestId !== "string" ||
      typeof result.status !== "string"
    ) {
      throw new Error(`${functionName}_unexpected_result`);
    }
    return {
      returnRequestId: result.returnRequestId,
      status: result.status,
      replayed: result.replayed === true,
    };
  };

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

function parameter(value: unknown): unknown {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}
