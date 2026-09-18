import {
  startHiddenCheckoutRuntimeResponseSchema,
  type StartHiddenCheckoutRuntimeRequest,
} from "../../../../src/domains/commerce/runtimeContracts.js";
import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
  type CommerceCheckoutRuntimeOrderPort,
  type FinalizedCheckoutOrder,
} from "../../../../src/domains/commerce/runtimePorts.js";
import { createOrderDraftSnapshotFromQuoteSnapshot } from "../../../../src/domains/commerce/orderDraftSnapshotContracts.js";
import { safeCommerceDiagnosticValue } from "../../../domains/commerce/commerceDiagnostics.js";

const FINALIZE_RPC_NAME = "commerce_finalize_order_for_checkout";

export interface ManagedCommerceRuntimeClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function createManagedCommerceRuntimeOrderPort(
  client: ManagedCommerceRuntimeClient,
): CommerceCheckoutRuntimeOrderPort {
  return {
    async finalizeOrderForCheckout(
      request: StartHiddenCheckoutRuntimeRequest,
    ): Promise<FinalizedCheckoutOrder> {
      const orderId = uuidFromOrderRef(request.orderDraft.orderId);
      const { data, error } = await client.rpc(FINALIZE_RPC_NAME, {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: orderId,
        p_mode: request.mode,
        p_client_id: request.clientId,
        p_shipping_address_id: request.shippingAddressId,
        p_pet_id: request.petId ?? null,
        p_quote_snapshot: request.orderDraft.quoteSnapshot,
        p_order_draft_snapshot: createOrderDraftSnapshotFromQuoteSnapshot(
          request.orderDraft.quoteSnapshot,
        ),
        p_metadata: {
          ...request.metadata,
          source: "commerce.runtime.hidden.v0",
        },
      });
      if (error) throw mapRpcError(error);
      return parseFinalizeResponse(data);
    },
  };
}

function uuidFromOrderRef(orderRef: string): string {
  return orderRef.replace(/^order_/, "");
}

function parseFinalizeResponse(data: unknown): FinalizedCheckoutOrder {
  const parsed = startHiddenCheckoutRuntimeResponseSchema
    .pick({ contractVersion: true })
    .passthrough()
    .safeParse(data);
  if (!parsed.success || typeof data !== "object" || data === null) {
    throw new CommerceRuntimePersistenceError("Commerce finalize response invalid");
  }
  const finalizedOrder = (data as { finalizedOrder?: unknown }).finalizedOrder;
  if (!finalizedOrder || typeof finalizedOrder !== "object") {
    throw new CommerceRuntimePersistenceError("Commerce finalize response invalid");
  }
  const order = finalizedOrder as FinalizedCheckoutOrder;
  if (!Array.isArray(order.items) || order.items.length === 0) {
    throw new CommerceRuntimePersistenceError("Commerce finalize response missing order items");
  }
  return order;
}

export function mapRpcError(error: RpcError): Error {
  // Diagnostic only: preserve constraint/cause signal without raw payload values.
  console.error(
    "commerce_runtime_finalize_rpc_error",
    JSON.stringify({
      code: error.code,
      message: safeCommerceDiagnosticValue(error.message),
      details: safeCommerceDiagnosticValue(error.details),
      hint: safeCommerceDiagnosticValue(error.hint),
    }),
  );
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (text.includes("commerce_runtime_finalize_journey_consumed")) {
    // The journey key already finalized a different request (order completed,
    // possibly out-of-band via checkout recovery). The client must rotate its
    // journey key — a retry under the same key can never succeed.
    return new CommerceRuntimeConflictError("Commerce checkout journey already completed", {
      code: error.code,
      reason: "journey_consumed",
    });
  }
  if (
    error.code === "23505" ||
    /commerce_runtime_finalize_.*(?:conflict|not_found|not_owned|mismatch|missing|requires|unknown|invalid|not_draft)/.test(
      text,
    )
  ) {
    return new CommerceRuntimeConflictError("Commerce order finalize conflict", { code: error.code });
  }
  return new CommerceRuntimePersistenceError("Commerce order finalize RPC failed", { code: error.code });
}
