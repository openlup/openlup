import type { z } from "zod";
import { CommerceRuntimeConflictError, CommerceRuntimePersistenceError } from "../runtimeErrors.js";
import type { CommerceCheckoutRuntimeOrderPort } from "../contracts/runtimePorts.js";
import type { RpcError } from "../contracts/omsTypes.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";
const FINALIZE_RPC_NAME = "commerce_finalize_order_for_checkout";

export interface ManagedCommerceRuntimeClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export function createManagedCommerceRuntimeOrderPort<Request, Order extends { items: unknown[] }>(
  client: ManagedCommerceRuntimeClient,
  bindings: { finalizeArgs(request: Request): Record<string, unknown>; responseEnvelopeSchema: z.ZodType },
): CommerceCheckoutRuntimeOrderPort<Request, Order> {
  return {
    async finalizeOrderForCheckout(request: Request): Promise<Order> {
      const { data, error } = await client.rpc(FINALIZE_RPC_NAME, bindings.finalizeArgs(request));
      if (error) throw mapRpcError(error);
      return parseFinalizeResponse(data);
    },
  };
  function parseFinalizeResponse(data: unknown): Order {
    const parsed = bindings.responseEnvelopeSchema.safeParse(data);
    if (!parsed.success || typeof data !== "object" || data === null) {
      throw new CommerceRuntimePersistenceError("Commerce finalize response invalid");
    }
    const finalizedOrder = (data as { finalizedOrder?: unknown }).finalizedOrder;
    if (!finalizedOrder || typeof finalizedOrder !== "object") {
      throw new CommerceRuntimePersistenceError("Commerce finalize response invalid");
    }
    const order = finalizedOrder as Order;
    if (!Array.isArray(order.items) || order.items.length === 0) {
      throw new CommerceRuntimePersistenceError("Commerce finalize response missing order items");
    }
    return order;
  }
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
  if (text.includes("acquisition_terms_changed")) {
    return new CommerceRuntimeConflictError("Acquisition terms changed", {
      code: error.code, reason: "acquisition_terms_changed",
    });
  }
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
